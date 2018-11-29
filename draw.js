/*jslint node: true */
'use strict';
const constants = require('byteballcore/constants.js');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus');
const validationUtils = require('byteballcore/validation_utils');
const headlessWallet = require('headless-byteball');
const crypto = require('crypto');
const BigNumber = require('bignumber.js');
const moment = require('moment');
const desktopApp = require('byteballcore/desktop_app.js');
const async = require('async');
const fs = require('fs');
const mutex = require('byteballcore/mutex');

BigNumber.config({DECIMAL_PLACES: 1e8, EXPONENTIAL_AT: [-1e+9, 1e9]});

function getTextToSign(address){
	return "I confirm that I own the address "+address+" and want it to participate in the draw airdrop.";
}

let myAddress;

eventBus.once('headless_wallet_ready', () => {
	headlessWallet.setupChatEventHandlers();
	
	db.query("SELECT address FROM my_addresses", [], function (rows) {
		if (rows.length === 0)
			throw Error("no addresses");
		myAddress = rows[0].address;
	});
	
	eventBus.on('paired', async (from_address, pairing_secret) => {
		const device = require('byteballcore/device.js');
		let user = await getUserByCode(pairing_secret);
		if (user) {
			await setRefCode(from_address, pairing_secret);
		}
		device.sendMessageToDevice(from_address, 'text', "Welcome! Please send me your address");
	});
	
	eventBus.on('text', async (from_address, text) => {
		const device = require('byteballcore/device.js');
		text = text.trim();
		let userInfo = await getUserInfo(from_address);
		let addressesRows = await getAddresses(from_address);
		let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
		
		if (validationUtils.isValidAddress(text)) {
			let addressInfo = await getAddressInfo(text);
			if (addressInfo && addressInfo.device_address !== from_address) {
				device.sendMessageToDevice(from_address, 'text', 'Address already registered by another user.');
			} else {
				if (addressInfo && addressInfo.signed === 1) {
					return device.sendMessageToDevice(from_address, 'text', 'Address already added and is participating in the draw.');
				} else {
					if (!addressInfo) await saveAddress(from_address, text);
					await setStep(from_address, 'sign');
					return device.sendMessageToDevice(from_address, 'text', 'Saved your address.\n\n' + pleaseSign(text));
				}
			}
		} else if (arrSignedMessageMatches) {
			let signedMessageBase64 = arrSignedMessageMatches[1];
			let validation = require('byteballcore/validation.js');
			let signedMessageJson = Buffer(signedMessageBase64, 'base64').toString('utf8');
			let objSignedMessage;
			try {
				objSignedMessage = JSON.parse(signedMessageJson);
			}
			catch (e) {
				return null;
			}
			validation.validateSignedMessage(objSignedMessage, async err => {
				if (err)
					return device.sendMessageToDevice(from_address, 'text', err);
				let address = objSignedMessage.authors[0].address;
				if (objSignedMessage.signed_message !== getTextToSign(address))
					return device.sendMessageToDevice(from_address, 'text', "You signed a wrong message: " +
						objSignedMessage.signed_message + ", expected: " + getTextToSign(address));
				if (!(await addressBelongsToUser(from_address, address)))
					return device.sendMessageToDevice(from_address, 'text', "You signed the message with a wrong address: " + address);
				await saveSigned(from_address, address);
				if (userInfo.referrerCode) {
					await setStep(from_address, 'go');
					await sendGo(from_address, userInfo);
				} else {
					await setStep(from_address, 'ref');
					device.sendMessageToDevice(from_address, 'text', "Who invited you? Please send me his/her referrer code. Or [skip](command:skip ref) this step. If you win, the referrer will also win an additional prize.");
				}
			});
		} else if (!userInfo || !addressesRows.length || text === 'add new address') {
			return device.sendMessageToDevice(from_address, 'text', 'Please send me your address.');
		} else if (text === 'skip ref') {
			await setRefCode(from_address, null);
			await setStep(from_address, 'go');
			await sendGo(from_address, userInfo);
		} else if (text === 'ref') {
			let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND attested = 1 AND signed = 1", [from_address]);
			if (rows.length) {
				const invite_code = device.getMyDevicePubKey() + '@' + conf.hub + '#' + userInfo.code;
				const qr_url = conf.site+"/qr/?code="+ encodeURIComponent(invite_code);
				return device.sendMessageToDevice(from_address, 'text', 'If you refer new users and one of them wins, you also win '+(conf.rewardForReferrerInBytes/1e9)+' GB and '+(conf.rewardForReferrerInBlackbytes/1e9)+' GBB. There are three ways to invite new users and ensure that the referrals are tracked to you:\n➡ have new users scan this QR code with wallet app '+qr_url+' , which opens this bot in the user\'s wallet, the wallet has to be already installed;\n➡ have new users copy-paste this to \"Chat > Add a new device > Accept invitation from the other device '+invite_code+' , which opens this bot in the user\'s wallet, the wallet has to be already installed;\n ➡ have new users enter your referrer code ' + userInfo.code + ' when the bot asks them about the referrer.');
			} else {
				return device.sendMessageToDevice(from_address, 'text', 'To participate in the referral program you need to link at least one real-name attested address.  If you are not attested yet, find "Real name attestation bot" in the Bot Store and go through the attestation.  If you are already attested, switch to your attested wallet and [link its address](command:add new address).  The Draw Airdrop Bot will not know any of your personal details, it needs just the fact that you are attested.');
			}
		} else if (userInfo.step === 'ref') {
			if (userInfo.code === text) return device.sendMessageToDevice(from_address, 'text', 'You can\'t refer yourself');
			let user = await getUserByCode(text);
			if (user) {
				await setRefCode(from_address, text);
				await sendGo(from_address, 'go');
			} else {
				device.sendMessageToDevice(from_address, 'text', 'Please send a valid referrer code or [skip](command:skip ref)');
			}
		} else {
			await sendGo(from_address, userInfo);
		}
	});
});

async function sendGo(device_address) {
	const device = require('byteballcore/device');
	let addressesRows = await getAddresses(device_address);
	let addresses = addressesRows.map(row => row.address);
	let assocAddressesToAttested = await checkAttestationsOfAddresses(addresses);
	let sum = new BigNumber(0);
	let text = '';
	for (let i = 0; i < addressesRows.length; i++) {
		let address = addressesRows[i].address;
		let attested = assocAddressesToAttested[address];
		let objPoints = await calcPoints(await getAddressBalance(address), address);
		text += address + '\n(' + (attested ? 'attested' : 'non-attested') + '), points: ' + objPoints.points + '\n' +
			(objPoints.pointsForBalanceAboveThreshold.toNumber() > 0 ?
				objPoints.pointsForBalanceAboveThreshold.toString() + ' points for balance above ' + conf.balanceThreshold + ' GB\n' : '') +
			(objPoints.pointsForBalanceBelowThreshold.toNumber() > 0 ?
				objPoints.pointsForBalanceBelowThreshold.toString() + ' points for balance below ' + conf.balanceThreshold + ' GB\n' : '') +
			(objPoints.pointsForChange.toNumber() ?
				objPoints.pointsForChange.toString() + ' points for balance change from the previous draw' : '') +
			'';
		sum = sum.add(objPoints.points);
	}
	device.sendMessageToDevice(device_address, 'text', 'Total points: ' + sum.toString() + '\n\n' + text +
		'\n[Add another address](command:add new address)' +
		'\nIf you refer new users and one of them wins, you also win. [Learn more](command:ref).');
}

function pleaseSign(address) {
	return 'Please prove ownership of your address by signing a message: [message](sign-message-request:' + getTextToSign(address) + ')';
}

function getUserInfo(device_address) {
	return new Promise(resolve => {
		db.query("SELECT code, referrerCode, step FROM users WHERE device_address = ?", [device_address], rows => {
			if (rows) {
				return resolve(rows[0]);
			} else {
				return resolve(null);
			}
		});
	});
}

async function getAddresses(device_address) {
	return await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND signed = 1", [device_address]);
}

async function addressBelongsToUser(device_address, address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND address = ?", [device_address, address]);
	return !!rows.length;
}

async function saveAddress(device_address, user_address) {
	let rows = await db.query("SELECT device_address FROM users WHERE device_address = ?", [device_address]);
	if (!rows.length) {
		let code = makeCode();
		while ((await db.query("SELECT code FROM users WHERE code = ?", [code])).length) {
			code = makeCode();
		}
		await db.query("INSERT INTO users (device_address, code) values (?,?)", [device_address, code]);
		await db.query("INSERT INTO user_addresses (device_address, address) values (?,?)", [device_address, user_address]);
	} else {
		await db.query("INSERT " + db.getIgnore() + " INTO user_addresses (device_address, address) values (?,?)",
			[device_address, user_address]);
	}
}

async function saveSigned(device_address, address) {
	await db.query("UPDATE user_addresses SET signed = 1 WHERE device_address = ? AND address = ?", [device_address, address]);
	return true;
}

function getUserByCode(code) {
	return new Promise(resolve => {
		db.query("SELECT * FROM users WHERE code = ?", [code], rows => {
			if (rows.length) {
				return resolve(rows[0]);
			} else {
				return resolve(null);
			}
		})
	});
}

function setRefCode(device_address, code) {
	return new Promise(resolve => {
		db.query("UPDATE users SET referrerCode = ? WHERE device_address = ?", [code, device_address], () => {
			return resolve();
		})
	});
}

async function getAddressBalance(address) {
	let rows = await db.query(
		"SELECT asset, is_stable, SUM(amount) AS balance \n\
		FROM outputs JOIN units USING(unit) \n\
		WHERE is_spent=0 AND address=? AND sequence='good' AND asset IS NULL AND is_stable = 1", [address]);
	if (rows.length) {
		return rows[0].balance;
	} else {
		return 0;
	}
}

setInterval(async () => {
	if (moment() > moment(conf.drawDate, 'DD.MM.YYYY hh:mm')) {
		updateNextRewardInConf();
		let arrPoints = [];
		let sum = new BigNumber(0);
		let rows3 = await db.query("SELECT address FROM user_addresses WHERE signed = 1");
		let assocAddressesToBalance = {};
		rows3.forEach(row => {
			assocAddressesToBalance[row.address] = 0;
		});
		let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
				FROM outputs JOIN units USING(unit)\n\
				WHERE is_spent=0 AND address IN(SELECT address FROM user_addresses WHERE signed = 1) AND sequence='good' AND asset IS NULL\n\
				GROUP BY address", []);
		
		for (let i = 0; i < rows1.length; i++) {
			let row = rows1[i];
			assocAddressesToBalance[row.address] = row.balance;
			let points = (await calcPoints(row.balance, row.address)).points;
			if (points.gt(0)) {
				arrPoints[i] = {address: row.address, points};
				sum = sum.add(points);
			}
		}
		
		let rows = await db.query("SELECT value FROM data_feeds CROSS JOIN units USING(unit) \n\
			CROSS JOIN unit_authors USING(unit) WHERE main_chain_index > 3765166 AND _mci > 3765166 AND \n\
			address = ? AND \n\
			feed_name='bitcoin_hash' AND sequence='good' AND is_stable=1 ORDER BY _mci DESC LIMIT 1", [conf.oracle]);
		
		let value = rows[0].value;
		let hash = crypto.createHash('sha256').update(value).digest('hex');
		let number = new BigNumber(hash, 16);
		let random = (number.div(new BigNumber(2).pow(256))).times(sum);
		
		let sum2 = new BigNumber(0);
		let winner_address;
		for (let i = 0; i < arrPoints.length; i++) {
			sum2 = sum2.add(arrPoints[i].points);
			if (random.lte(sum2)) {
				winner_address = arrPoints[i].address;
				break;
			}
		}
		let refAddress = await getReferrerFromAddress(winner_address);
		let winnerDeviceAddress = '';
		let refDeviceAddress = null;
		let rows2 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [winner_address]);
		winnerDeviceAddress = rows2[0].device_address;
		if (refAddress) {
			let rows3 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [refAddress]);
			refDeviceAddress = rows3[0].device_address;
		}
		let insertMeta = await db.query("INSERT INTO draws (bitcoin_hash, winner_address, referrer_address, sum) values (?,?,?,?)",
			[value, winner_address, refAddress, sum.toNumber()]);
		let draw_id = insertMeta.insertId;
		
		await new Promise(resolve => {
			let arrQueries = [];
			db.takeConnectionFromPool(function (conn) {
				conn.addQuery(arrQueries, "BEGIN");
				rows1.forEach(row => {
					conn.addQuery(arrQueries, "INSERT INTO prev_balances (draw_id, address, balance) values (?,?,?)",
						[draw_id, row.address, assocAddressesToBalance[row.address]]);
				});
				conn.addQuery(arrQueries, "COMMIT");
				async.series(arrQueries, () => {
					conn.release();
					resolve();
				});
			});
		});
		pay(value);
		await sendNotification(draw_id, winnerDeviceAddress, refDeviceAddress, winner_address, refAddress);
	}
}, 60000);

async function sendNotification(draw_id, winnerDeviceAddress, refDeviceAddress, winner_address, referrer_address) {
	let device = require('byteballcore/device');
	let rows = await db.query("SELECT device_address FROM users");
	rows.forEach(row => {
		device.sendMessageToDevice(row.device_address, 'text', 'The winner of the draw #'+draw_id+' is ' + winner_address +
			(winnerDeviceAddress === row.device_address ? ' (you)' : '') + ' and the winner receives a prize of '+(conf.rewardForWinnerInBytes/1e9)+' GB and '+(conf.rewardForWinnerInBlackbytes/1e9)+' GBB, congratulations to the winner!' +
			(referrer_address !== null 
			? '\n\nThe winner was referred by ' + referrer_address + (refDeviceAddress === row.device_address ? ' (you)' : '') + ' and the referrer receives a prize of '+(conf.rewardForReferrerInBytes/1e9)+' GB and '+(conf.rewardForReferrerInBlackbytes/1e9)+' GBB, congratulations to the winner\'s referrer!'
			: '')
		);
	});
}

setInterval(async () => {
	let rows = await db.query("SELECT bitcoin_hash FROM draws WHERE paid_bytes = 0 OR paid_winner_bb = 0 OR (paid_referrer_bb = 0 AND referrer_address IS NOT NULL)");
	rows.forEach(row => {
		pay(row.bitcoin_hash);
	})
}, conf.payoutCheckInterval);

function pay(bitcoin_hash) {
	mutex.lock(["pay_lock"], async (unlock) => {
		let rows = await db.query("SELECT * FROM draws WHERE bitcoin_hash = ?", [bitcoin_hash]);
		let draw = rows[0];
		
		if (draw.paid_bytes === 0) {
			try {
				let result = await payBytes(draw);
				await db.query("UPDATE draws SET paid_bytes = 1, paid_bytes_unit = ? WHERE bitcoin_hash = ?", [result.unit, bitcoin_hash]);
			} catch (e) {
				console.error('Error payBytes: ', e);
			}
		}
		
		if (draw.paid_winner_bb === 0) {
			try {
				let result2 = await payBlackbytesToWinner(draw);
				await db.query("UPDATE draws SET paid_winner_bb = 1, paid_winner_bb_unit = ? WHERE bitcoin_hash = ?", [result2.unit, bitcoin_hash]);
			} catch (e) {
				console.error('Error payBlackbytesToWinner: ', e);
			}
		}
		
		if (draw.paid_referrer_bb === 0 && draw.referrer_address) {
			try {
				let result3 = payBlackbytesToReferrer(draw);
				await db.query("UPDATE draws SET paid_referrer_bb = 1, paid_referrer_bb_unit = ? WHERE bitcoin_hash = ?", [result3.unit, bitcoin_hash]);
			}catch (e) {
				console.error('Error payBlackbytesToReferrer: ', e);
			}
		}
		unlock();
	});
}

function payBytes(row) {
	let outputs = [{address: row.winner_address, amount: conf.rewardForWinnerInBytes}];
	if (row.referrer_address !== null) {
		outputs.push({address: row.referrer_address, amount: conf.rewardForReferrerInBytes});
	}
	
	return headlessWallet.sendPaymentUsingOutputs('base', outputs, myAddress);
}

async function payBlackbytesToWinner(row) {
	let rows = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [row.winner_address]);
	return headlessWallet.sendAssetFromAddress(constants.BLACKBYTES_ASSET, conf.rewardForWinnerInBlackbytes, myAddress, row.winner_address,
		rows[0].device_address);
}

async function payBlackbytesToReferrer(row) {
	let rows = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [row.referrer_address]);
	return headlessWallet.sendAssetFromAddress(constants.BLACKBYTES_ASSET, conf.rewardForReferrerInBlackbytes, myAddress, row.referrer_address,
		rows[0].device_address);
}

function updateNextRewardInConf() {
	let appDataDir = desktopApp.getAppDataDir();
	let userConfFile = appDataDir + '/conf.json';
	let json;
	try {
		json = require(userConfFile);
	} catch (e) {
		json = {};
	}
	
	conf.nextDate = moment(conf.drawDate, 'DD.MM.YYYY hh:mm').add(conf.drawInterval, 'days');
	json.nextDate = conf.nextDate;
	fs.writeFile(userConfFile, JSON.stringify(json, null, '\t'), 'utf8', (err) => {
		if (err)
			throw Error('failed to write conf.json: ' + err);
	});
}

async function calcPoints(balance, address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ? AND signed = 1", [address]);
	if (!rows.length) return {
		points: 0,
		pointsForBalanceAboveThreshold: 0,
		pointsForBalanceBelowThreshold: 0,
		pointsForChange: 0
	};
	
	let bnBalance = new BigNumber(balance).div(conf.unitValue);
	let bnThreshold = new BigNumber(conf.balanceThreshold);
	let thresholdInBytes = conf.balanceThreshold * conf.unitValue;
	let pointsForBalanceAboveThreshold = new BigNumber(0);
	let pointsForBalanceBelowThreshold = new BigNumber(0);
	let points = new BigNumber(0);
	let pointsForChange = new BigNumber(0);
	if (rows[0].attested) {
		if (balance > thresholdInBytes) {
			pointsForBalanceAboveThreshold = bnBalance.minus(bnThreshold).times(conf.multiplierForAmountAboveThreshold);
			pointsForBalanceBelowThreshold = bnThreshold;
		} else {
			pointsForBalanceBelowThreshold = bnBalance;
		}
		points = pointsForBalanceBelowThreshold.add(pointsForBalanceAboveThreshold);
	} else {
		points = bnBalance.times(conf.multiplierForNonAttested);
	}
	let rows2 = await db.query("SELECT balance FROM prev_balances WHERE address = ? AND draw_id=(SELECT draw_id FROM draws ORDER BY draw_id DESC LIMIT 1)", [address]);
	if (rows2.length) {
		let prev_balance = rows2[0].balance;
		let deltaInGB = bnBalance.minus(new BigNumber(prev_balance).div(conf.unitValue));
		if (balance > prev_balance) {
			pointsForChange = deltaInGB.times(conf.multiplierForBalanceIncrease);
			points = points.add(pointsForChange);
		} else if (balance < prev_balance) {
			pointsForChange = deltaInGB.times(conf.multiplierForBalanceDecrease);
			points = points.add(pointsForChange);
		}
	}
	return {points: points, pointsForBalanceAboveThreshold, pointsForBalanceBelowThreshold, pointsForChange};
}

async function getReferrerFromAddress(address) {
	let rows = await db.query("SELECT referrerCode, attested FROM user_addresses JOIN users USING(device_address) WHERE address = ? AND signed = 1",
		[address]);
	if (!rows.length || rows[0].attested === 0)
		return null;
	if (!rows[0].referrerCode)
		return null;
	let rows2 = await db.query("SELECT address FROM users JOIN user_addresses USING(device_address) WHERE code = ? AND attested = 1 AND signed = 1",
		[rows[0].referrerCode]);
	return rows2.length ? rows2[0].address : null;
}

function setStep(device_address, step) {
	return new Promise(resolve => {
		db.query("UPDATE users SET step = ? WHERE device_address = ?", [step, device_address], () => {
			return resolve();
		});
	});
}

const Koa = require('koa');
const app = new Koa();
const views = require('koa-views');

app.use(views(__dirname + '/views', {
	map: {
		html: 'ejs'
	}
}));

app.use(async ctx => {
	let rows = await db.query("SELECT * FROM draws ORDER BY date DESC LIMIT 1");
	let addressesInfo = await getAddressesInfoForSite();
	if (rows.length) {
		addressesInfo.nonDraws = false;
		addressesInfo.winner_address = rows[0].winner_address;
		addressesInfo.referrer_address = rows[0].referrer_address;
		addressesInfo.lastSum = rows[0].sum;
	} else {
		addressesInfo.nonDraws = true;
	}
	await ctx.render('index', addressesInfo);
});

async function getAddressesInfoForSite() {
	let sum = new BigNumber(0);
	let rows = await db.query("SELECT address, attested, referrerCode FROM user_addresses JOIN users USING(device_address) WHERE signed = 1");
	let objAddresses = {};
	let addresses = [];
	rows.forEach(row => {
		addresses.push(row.address);
		objAddresses[row.address] = {attested: row.attested, points: "0", referrerCode: row.referrerCode};
	});
	
	let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
			FROM outputs \n\
			WHERE is_spent=0 AND address IN("+addresses.map(db.escape).join(', ')+")  AND asset IS NULL\n\
			GROUP BY address ORDER BY balance DESC");
	for (let i = 0; i < rows1.length; i++) {
		let row = rows1[i];
		let points = (await calcPoints(row.balance, row.address)).points;
		objAddresses[row.address].points = points.toString();
		sum = sum.add(points);
	}
	sum = sum.toString();
	return {objAddresses, sum};
}

async function checkAttestationsOfAddresses(addresses) {
	let assocAddressesToAttested = {};
	addresses.forEach(address => {
		assocAddressesToAttested[address] = false;
	});
	let rows = await db.query("SELECT address FROM attestations WHERE attestor_address IN(?) AND address IN(?)",
		[conf.arrRealNameAttestors, addresses]);
	let attested_addresses = [];
	rows.forEach(row => {
		attested_addresses.push(row.address);
		assocAddressesToAttested[row.address] = true;
	});
	await db.query("UPDATE user_addresses SET attested = 1 WHERE address IN(?)", [attested_addresses]);
	return assocAddressesToAttested;
}

async function getAddressInfo(address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ?", [address]);
	return rows.length ? rows[0] : null;
}

function makeCode() {
	let text = "";
	let possible = "abcdefghijklmnopqrstuvwxyz0123456789";
	
	for (let i = 0; i < 10; i++)
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	
	return text;
}

app.listen(3000);

process.on('unhandledRejection', up => { throw up; });
