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

const STRING_FOR_SIGN = 'I authorize the use of my signature bot: ' + conf.deviceName;

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
				device.sendMessageToDevice(from_address, 'text', 'Address already in use');
			} else {
				if (addressInfo && addressInfo.signed === 1) {
					return device.sendMessageToDevice(from_address, 'text', 'Address already added is participating in the draw');
				} else {
					if (!addressInfo) await saveAddress(from_address, text);
					await setStep(from_address, 'sign');
					return device.sendMessageToDevice(from_address, 'text', 'I save your address. \n' + textSign());
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
				if (objSignedMessage.signed_message !== STRING_FOR_SIGN)
					return device.sendMessageToDevice(from_address, 'text', "You signed a wrong message: " +
						objSignedMessage.signed_message + ", expected: " + STRING_FOR_SIGN);
				if (!(await addressBelongsToUser(from_address, objSignedMessage.authors[0].address)))
					return device.sendMessageToDevice(from_address, 'text', "You signed the message with a wrong address: " +
						objSignedMessage.authors[0].address);
				await saveSigned(from_address, objSignedMessage.authors[0].address);
				if (userInfo.referrerCode) {
					await setStep(from_address, 'go');
					await sendGo(from_address, userInfo);
				} else {
					await setStep(from_address, 'ref');
					device.sendMessageToDevice(from_address, 'text', "Who invited you? Please send me his(her) ref code. Or [skip](command:skipRef)");
				}
			});
		} else if (!userInfo || !addressesRows.length || text === 'addNewAddress') {
			return device.sendMessageToDevice(from_address, 'text', 'Please send me your address');
		} else if (text === 'skipRef') {
			await setRefCode(from_address, null);
			await setStep(from_address, 'go');
			await sendGo(from_address, userInfo);
		} else if (text === 'ref') {
			let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND attested = 1 AND signed = 1", [from_address]);
			if (rows.length) {
				device.sendMessageToDevice(from_address, 'text', 'To attract referrals, use your code: ' + userInfo.code +
					'\nor pairing code:');
				return device.sendMessageToDevice(from_address, 'text', device.getMyDevicePubKey() + '@' + conf.hub + '#' + userInfo.code);
			} else {
				return device.sendMessageToDevice(from_address, 'text', 'To participate in the referral program you must have at least 1 attested address');
			}
		} else if (userInfo.step === 'ref') {
			if (userInfo.code === text) return device.sendMessageToDevice(from_address, 'text', 'You can\'t choose yourself');
			let user = await getUserByCode(text);
			if (user) {
				await setRefCode(from_address, text);
				await sendGo(from_address, 'go');
			} else {
				device.sendMessageToDevice(from_address, 'text', 'Please send valid ref code or [skip](command:skipRef)');
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
	let assocAddressesToAttested = await checkAttestationAddresses(addresses);
	let sum = new BigNumber(0);
	let text = '';
	for (let i = 0; i < addressesRows.length; i++) {
		let address = addressesRows[i].address;
		let attested = assocAddressesToAttested[address];
		let objPoints = await calcPoints(await getAddressBalance(address), address);
		text += address + '\n(' + (attested ? 'attested' : 'non-attested') + '), points: ' + objPoints.total + '\n' +
			(objPoints.pointsForBalanceAboveThreshold.toNumber() > 0 ?
				objPoints.pointsForBalanceAboveThreshold.toString() + ' points for sum more ' + conf.balanceThreshold + ' gb\n' : '') +
			(objPoints.pointsForBalanceBelowThreshold.toNumber() > 0 ?
				objPoints.pointsForBalanceBelowThreshold.toString() + ' points for sum less ' + conf.balanceThreshold + ' gb\n' : '') +
			(objPoints.change.toNumber() ?
				objPoints.change.toString() + ' points for the changes from the last draw' : '') +
			'';
		sum = sum.add(objPoints.total);
	}
	device.sendMessageToDevice(device_address, 'text', 'Your points: ' + sum.toString() + '\n\n' + text +
		'\n[Add new address](command:addNewAddress)' +
		'\n[My ref](command:ref)');
}

function textSign() {
	return 'Please prove ownership of your address by signing a message: [message](sign-message-request:' + STRING_FOR_SIGN + ')';
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
			let points = (await calcPoints(row.balance, row.address)).total;
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
		
		await new Promise(resolve => {
			let arrQueries = [];
			db.takeConnectionFromPool(function (conn) {
				conn.addQuery(arrQueries, "BEGIN");
				rows1.forEach(row => {
					conn.addQuery(arrQueries, "INSERT INTO prev_balances (draw_id, address, balance) values (?,?,?)",
						[insertMeta.insertId, row.address, assocAddressesToBalance[row.address]]);
				});
				conn.addQuery(arrQueries, "COMMIT");
				async.series(arrQueries, () => {
					conn.release();
					resolve();
				});
			});
		});
		pay(value);
		await sendNotification(winnerDeviceAddress, refDeviceAddress, winner_address, refAddress);
	}
}, 60000);

async function sendNotification(winnerDeviceAddress, refDeviceAddress, winner_address, referrer_address) {
	let device = require('byteballcore/device');
	let rows = await db.query("SELECT device_address FROM users");
	rows.forEach(row => {
		device.sendMessageToDevice(row.device_address, 'text', 'Winner - ' + winner_address +
			(winnerDeviceAddress === row.device_address ? ' (you)' : '') + '\n' +
			(referrer_address !== null ? 'referrer: ' + referrer_address + (refDeviceAddress === row.device_address ? ' (you)' : '') : '')
		);
	});
}

setInterval(async () => {
	let rows = await db.query("SELECT bitcoin_hash FROM draws WHERE paid_bytes = 0 OR paid_winner_bb = 0 OR paid_referrer_bb = 0");
	rows.forEach(row => {
		pay(row.bitcoin_hash);
	})
}, conf.payoutCheckInterval);

function pay(bitcoin_hash) {
	mutex.lock(["pay_lock"], async (unlock) => {
		let rows = await db.query("SELECT * FROM draws WHERE bitcoin_hash = ?", [bitcoin_hash]);
		
		if (rows[0].paid_bytes === 0) {
			try {
				let result = await payBytes(rows[0]);
				await db.query("UPDATE draws SET paid_bytes = 1, paid_bytes_unit = ? WHERE bitcoin_hash = ?", [result.unit, bitcoin_hash]);
			} catch (e) {
				console.error('Error payBytes: ', e);
			}
		}
		
		if (rows[0].paid_winner_bb === 0) {
			try {
				let result2 = await payBBWinner(rows[0]);
				await db.query("UPDATE draws SET paid_winner_bb = 1, paid_winner_bb_unit = ? WHERE bitcoin_hash = ?", [result2.unit, bitcoin_hash]);
			} catch (e) {
				console.error('Error payBBWinner: ', e);
			}
		}
		
		if (rows[0].paid_referrer_bb === 0) {
			try {
				let result3 = payBBReferrer(rows[0]);
				await db.query("UPDATE draws SET paid_referrer_bb = 1, paid_referrer_bb_unit = ? WHERE bitcoin_hash = ?", [result3.unit, bitcoin_hash]);
			}catch (e) {
				console.error('Error payBBReferrer: ', e);
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

function payBBWinner(row) {
	return headlessWallet.sendPaymentUsingOutputs(constants.BLACKBYTES_ASSET, [{
		address: row.winner_address,
		amount: conf.rewardForWinnerInBlackBytes
	}], myAddress);
}

function payBBReferrer(row) {
	if (row.referrer_address !== null) {
		return headlessWallet.sendPaymentUsingOutputs(constants.BLACKBYTES_ASSET, [{
			address: row.referrer_address,
			amount: conf.rewardForReffererInBlackBytes
		}], myAddress);
	} else {
		return Promise.resolve({unit: '-'});
	}
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
		total: 0,
		pointsForBalanceAboveThreshold: 0,
		pointsForBalanceBelowThreshold: 0,
		change: 0
	};
	let rows2 = await db.query("SELECT balance FROM prev_balances WHERE address = ? ORDER BY date DESC LIMIT 0,1", [address]);
	
	let amountForNextCalc = conf.balanceThreshold * conf.unitValue;
	let pointsForBalanceAboveThreshold = new BigNumber(0);
	let pointsForBalanceBelowThreshold = new BigNumber(0);
	let change = new BigNumber(0);
	if (rows[0].attested) {
		if (balance > amountForNextCalc) {
			balance = new BigNumber(amountForNextCalc).add(new BigNumber(balance - amountForNextCalc).times(conf.multiplierMoreAmountNextCalc));
			pointsForBalanceAboveThreshold = new BigNumber(balance - amountForNextCalc).times(conf.multiplierMoreAmountNextCalc).div(conf.unitValue);
			pointsForBalanceBelowThreshold = new BigNumber(amountForNextCalc).div(conf.unitValue);
		} else {
			pointsForBalanceBelowThreshold = new BigNumber(balance).div(conf.unitValue);
		}
	} else {
		balance = new BigNumber(balance).times(conf.multiplierNonAttested);
	}
	let total = new BigNumber(balance).div(conf.unitValue);
	if (rows2.length) {
		if (balance > rows2[0].balance) {
			let _change = (new BigNumber(balance).minus(rows2[0].balance)).times(conf.multiplierForIncreasingBalance).div(conf.unitValue);
			total = total.add(_change);
			change = _change;
		} else if (balance < rows2[0].balance) {
			let _change = (new BigNumber(balance).minus(rows2[0].balance)).times(conf.multiplierForDecreaseBalance).div(conf.unitValue);
			total = total.add(_change);
			change = _change;
		}
	}
	return {total: total, pointsForBalanceAboveThreshold, pointsForBalanceBelowThreshold, change};
}

async function getReferrerFromAddress(address) {
	let rows = await db.query("SELECT referrerCode, attested FROM user_addresses JOIN users USING(device_address) WHERE address = ? AND signed = 1",
		[address]);
	if (!rows.length || (rows.length && rows[0].attested === 0)) {
		return null;
	} else {
		if (rows[0].referrerCode === '' || rows[0].referrerCode === null) return null;
		let rows2 = await db.query("SELECT address FROM users JOIN user_addresses USING(device_address) WHERE code = ? AND attested = 1 AND signed = 1",
			[rows[0].referrerCode]);
		return rows2.length ? rows2[0].address : null;
	}
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
	let rows = await db.query("SELECT * FROM draws ORDER BY date DESC LIMIT 0,1");
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
			FROM outputs JOIN units USING(unit)\n\
			WHERE is_spent=0 AND address IN(?) AND sequence='good' AND asset IS NULL\n\
			AND is_stable = 1 GROUP BY address ORDER BY balance DESC", [addresses]);
	for (let i = 0; i < rows1.length; i++) {
		let row = rows1[i];
		let points = (await calcPoints(row.balance, row.address)).total;
		objAddresses[row.address].points = points.toString();
		sum = sum.add(points);
	}
	sum = sum.toString();
	return {objAddresses, sum};
}

async function checkAttestationAddresses(addresses) {
	let assocAddressesToAttested = {};
	addresses.forEach(address => {
		assocAddressesToAttested[address] = false;
	});
	let rows = await db.query("SELECT address FROM attestations WHERE attestor_address IN(?) AND address IN(?)",
		[conf.arrRealNameAttestors, addresses]);
	let _addresses = [];
	rows.forEach(row => {
		_addresses.push(row.address);
		assocAddressesToAttested[row.address] = true;
	});
	await db.query("UPDATE user_addresses SET attested = 1 WHERE address IN(?)", [_addresses]);
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
