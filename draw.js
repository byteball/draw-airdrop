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
const notifications = require('./notifications');

BigNumber.config({DECIMAL_PLACES: 1e8, EXPONENTIAL_AT: [-1e+9, 1e9]});

let assocReceivedGreeting = {};

function getTextToSign(address){
	return "I confirm that I own the address "+address+" and want it to participate in the draw airdrop.";
}

function getRulesText(){
	return '➡ for real-name attested addresses, 1 point per GB of balance up to '+conf.balanceThreshold+' GB, '+conf.multiplierForAmountAboveThreshold+' point for each GB of additional balance over '+conf.balanceThreshold+' GB;\n' +
		'➡ for unattested addresses, '+conf.multiplierForNonAttested+' point per GB of balance;\n' +
		'➡ '+conf.multiplierForBalanceIncrease+' point per GB of balance increase over the previous draw;\n' +
		'➡ -'+conf.multiplierForBalanceDecrease+' point per GB of balance decrease compared to the previous draw.';
}

function getGreetingText(){
	return "Welcome to our weekly airdrop!  Every week, we airdrop a prize of " + (conf.rewardForWinnerInBytes / 1e9) + " GB and " + (conf.rewardForWinnerInBlackbytes / 1e9) + " GBB to a single winner, and you have a chance to win.  It is like a lottery but you don't need to pay anything, just prove your existing balance.\n\nYour chances to win depend on the balances of the addresses you link here, the larger the balances, the more points you get.  The winner of the current draw will be selected randomly on " + conf.drawDate + " UTC and your chance to be selected depends on the points you have on that date: more points, higher chance.\n\nThe rules are designed in favor of smaller participants, larger balances add little to the points.  To get most points, you'll need to pass real name attestation and prove your real name (find \"Real name attestation bot\" in the Bot Store), the draw bot doesn't see your personal details, it needs just the fact that you are attested.  Full rules:\n" + getRulesText() + "\n\nIf you refer new users to this draw and one of them wins, you also win " + (conf.rewardForReferrerInBytes / 1e9) + " GB and " + (conf.rewardForReferrerInBlackbytes / 1e9) + " GBB, the instructions will be shown after you link your own address.\n\nPlease send me your address you want to link to the draw.";
}

function sendGreeting(device_address){
	const device = require('byteballcore/device.js');
	device.sendMessageToDevice(device_address, 'text', getGreetingText());
	assocReceivedGreeting[device_address] = true;
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
		let referring_user = await getUserByCode(pairing_secret);
		if (referring_user) {
			await createUser(from_address);
			await setRefCode(from_address, pairing_secret);
		}
		sendGreeting(from_address);
	});
	
	eventBus.on('text', async (from_address, text) => {
		const device = require('byteballcore/device.js');
		text = text.trim();
		let userInfo = await getUserInfo(from_address);
		let addressesRows = await getAddresses(from_address);
		let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
		
		if (validationUtils.isValidAddress(text)) {
			let addressInfo = await getAddressInfo(text);
			if (addressInfo) {
				return device.sendMessageToDevice(from_address, 'text', (addressInfo.device_address === from_address) ? 'This address is already added and is participating in the draw.' : 'This address is already registered by another user.');
			} else {
				return device.sendMessageToDevice(from_address, 'text', pleaseSign(text));
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
				let addressInfo = await getAddressInfo(text);
				if (addressInfo) {
					return device.sendMessageToDevice(from_address, 'text', (addressInfo.device_address === from_address) ? 'This address is already added and is participating in the draw.' : 'This address is already registered by another user.');
				}
				let attested = await saveAddress(from_address, address);
				device.sendMessageToDevice(from_address, 'text', "Thanks, added your address.  "+(attested ? "The address is attested and will earn you the maximum number of points" : "The address is not attested and will earn you "+(conf.multiplierForNonAttested)+" points per GB of balance.  Have your real name attested to maximize your points and chances to win."));
				if (userInfo && userInfo.referrerCode) {
					await setStep(from_address, 'done');
					await showStatus(from_address, userInfo);
				} else {
					await setStep(from_address, 'ref');
					device.sendMessageToDevice(from_address, 'text', "Who invited you? Please send me his/her referrer code. Or [skip](command:skip ref) this step. If you win, the referrer will also win an additional prize.");
				}
			});
		} else if ((!userInfo || !addressesRows.length) && !assocReceivedGreeting[from_address]) {
			return sendGreeting(from_address);
		} else if (!userInfo || !addressesRows.length || text === 'add new address') {
			return device.sendMessageToDevice(from_address, 'text', 'Please send me your address.');
		} else if (userInfo && text === 'skip ref') {
			await setRefCode(from_address, null);
			await setStep(from_address, 'done');
			await showStatus(from_address, userInfo);
		} else if (userInfo && text === 'ref') {
			let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND attested = 1", [from_address]);
			if (rows.length) {
				const invite_code = device.getMyDevicePubKey() + '@' + conf.hub + '#' + userInfo.code;
				const qr_url = conf.site + "/qr/?code=" + encodeURIComponent(invite_code);
				return device.sendMessageToDevice(from_address, 'text', 'If you refer new users and one of them wins, you also win ' + (conf.rewardForReferrerInBytes / 1e9) + ' GB and ' + (conf.rewardForReferrerInBlackbytes / 1e9) + ' GBB. There are three ways to invite new users and ensure that the referrals are tracked to you:\n➡ have new users scan this QR code with wallet app ' + qr_url + ' which opens this bot in the user\'s wallet;\n➡ have new users copy-paste this to \"Chat > Add a new device > Accept invitation from the other device ' + invite_code + ' which opens this bot in the user\'s wallet;\n ➡ have new users start this bot from the Bot Store and enter your referrer code ' + userInfo.code + ' when the bot asks them about the referrer.');
			} else {
				return device.sendMessageToDevice(from_address, 'text', 'To participate in the referral program you need to link at least one real-name attested address.  If you are not attested yet, find "Real name attestation bot" in the Bot Store and go through the attestation.  If you are already attested, switch to your attested wallet and [link its address](command:add new address).  The Draw Airdrop Bot will not know any of your personal details, it needs just the fact that you are attested.');
			}
		} else if (userInfo && userInfo.step === 'ref') {
			if (userInfo.code === text) return device.sendMessageToDevice(from_address, 'text', 'You can\'t refer yourself');
			let user = await getUserByCode(text);
			if (user) {
				await setRefCode(from_address, text);
				await showStatus(from_address, userInfo);
			} else {
				device.sendMessageToDevice(from_address, 'text', 'Please send a valid referrer code or [skip](command:skip ref)');
			}
		} else if (userInfo) {
			await showStatus(from_address, userInfo);
		}
	});
});

async function showStatus(device_address, userInfo) {
	const device = require('byteballcore/device');
	let addressesRows = await getAddresses(device_address);
	let sum = new BigNumber(0);
	let text = '';
	for (let i = 0; i < addressesRows.length; i++) {
		let address = addressesRows[i].address;
		let attested = addressesRows[i].attested;
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
	let totalPointsOfReferrals = await getPointsOfReferrals(userInfo.code);
	device.sendMessageToDevice(device_address, 'text', 'Your points: ' + sum.toString() + '\nTotal points of your referrals: ' + totalPointsOfReferrals +
		'\n\nLinked addresses:\n' + text +
		'\nChances to win are proportianal to the points you have. Current rules:\n' +
		getRulesText() +
		'\n\n[Add another address](command:add new address)' +
		'\nIf you refer new users and one of them wins, you also win. [Learn more](command:ref).'
	);
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
	return await db.query("SELECT * FROM user_addresses WHERE device_address = ?", [device_address]);
}

async function saveAddress(device_address, user_address) {
	let rows = await db.query("SELECT device_address FROM users WHERE device_address = ?", [device_address]);
	if (!rows.length) {
		await createUser(device_address);
	}
	let att_rows = await db.query("SELECT 1 FROM attestations WHERE attestor_address IN(?) AND address=?", [conf.arrRealNameAttestors, user_address]);
	let attested = (att_rows.length > 0) ? 1 : 0;
	await db.query("INSERT " + db.getIgnore() + " INTO user_addresses (device_address, address, attested) VALUES (?,?,?)", [device_address, user_address, attested]);
	return attested;
}

async function createUser(device_address){
	let code = makeCode();
	while ((await db.query("SELECT code FROM users WHERE code = ?", [code])).length) {
		code = makeCode();
	}
	await db.query("INSERT " + db.getIgnore() + " INTO users (device_address, code) VALUES (?,?)", [device_address, code]);	
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
		"SELECT SUM(amount) AS balance \n\
		FROM outputs JOIN units USING(unit) \n\
		WHERE is_spent=0 AND address=? AND sequence='good' AND asset IS NULL", [address]);
	if (rows.length) {
		return (rows[0].balance || 0);
	} else {
		return 0;
	}
}

async function getPointsOfReferrals(code) {
	let sum = new BigNumber(0);
	let rows = await db.query("SELECT address FROM users JOIN user_addresses USING(device_address) WHERE referrerCode = ?", [code]);
	let addresses = rows.map(row => row.address);
	if (!addresses.length) return "0";
	let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
				FROM outputs JOIN units USING(unit)\n\
				WHERE is_spent=0 AND address IN(?) AND sequence='good' AND asset IS NULL\n\
				GROUP BY address", [addresses]);
	
	for (let i = 0; i < rows1.length; i++) {
		let row = rows1[i];
		let points = (await calcPoints(row.balance, row.address)).total;
		if (points.gt(0)) {
			sum = sum.add(points);
		}
	}
	return sum.toString();
}

setInterval(async () => {
	if (moment() > moment(conf.drawDate, 'DD.MM.YYYY hh:mm')) {
		updateNextRewardInConf();
		let arrPoints = [];
		let sum = new BigNumber(0);
		let rows3 = await db.query("SELECT address FROM user_addresses");
		let assocAddressesToBalance = {};
		rows3.forEach(row => {
			assocAddressesToBalance[row.address] = 0;
		});
		let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
				FROM outputs JOIN units USING(unit)\n\
				WHERE is_spent=0 AND address IN(SELECT address FROM user_addresses) AND sequence='good' AND asset IS NULL\n\
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
		if (sum.eq(new BigNumber(0)))
			return;
		
		let rows = await db.query("SELECT value FROM data_feeds CROSS JOIN units USING(unit) CROSS JOIN unit_authors USING(unit) \n\
			WHERE address = ? AND +feed_name='bitcoin_hash' AND sequence='good' AND is_stable=1 ORDER BY data_feeds.rowid DESC LIMIT 1", [conf.oracle]);
		
		let bitcoin_hash = rows[0].value;
		let hash = crypto.createHash('sha256').update(bitcoin_hash).digest('hex');
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
		let rows2 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [winner_address]);
		let winnerDeviceAddress = rows2[0].device_address;
		let refDeviceAddress = null;
		if (refAddress) {
			let rows3 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [refAddress]);
			refDeviceAddress = rows3[0].device_address;
		}
		let insertMeta = await db.query("INSERT INTO draws (bitcoin_hash, winner_address, referrer_address, sum) VALUES (?,?,?,?)",
			[bitcoin_hash, winner_address, refAddress, sum.toNumber()]);
		let draw_id = insertMeta.insertId;
		
		await new Promise(resolve => {
			let arrQueries = [];
			db.takeConnectionFromPool(function (conn) {
				conn.addQuery(arrQueries, "BEGIN");
				rows1.forEach(row => {
					conn.addQuery(arrQueries, "INSERT INTO prev_balances (draw_id, address, balance) VALUES (?,?,?)",
						[draw_id, row.address, assocAddressesToBalance[row.address]]);
				});
				conn.addQuery(arrQueries, "COMMIT");
				async.series(arrQueries, () => {
					conn.release();
					resolve();
				});
			});
		});
		pay(draw_id);
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
			: '') +
			'\n\nThe next draw is scheduled for '+conf.drawDate+' UTC.  You can increase your chances to win by increasing the balance you linked or referring new users.  See the [details](command:status).'
		);
	});
}

setInterval(async () => {
	let rows = await db.query("SELECT draw_id FROM draws WHERE paid_bytes = 0 OR paid_winner_bb = 0 OR (paid_referrer_bb = 0 AND referrer_address IS NOT NULL)");
	rows.forEach(row => {
		pay(row.draw_id);
	})
}, conf.payoutCheckInterval);

function pay(draw_id) {
	mutex.lock(["pay_lock"], async (unlock) => {
		let rows = await db.query("SELECT * FROM draws WHERE draw_id = ?", [draw_id]);
		let draw = rows[0];
		
		if (draw.paid_bytes === 0) {
			try {
				let result = await payBytes(draw);
				await db.query("UPDATE draws SET paid_bytes = 1, paid_bytes_unit = ? WHERE draw_id = ?", [result.unit, draw_id]);
			} catch (e) {
				console.error('Error payBytes: ', e);
				notifications.notifyAdmin('payBytes failed', e.toString());
			}
		}
		
		if (draw.paid_winner_bb === 0) {
			try {
				let result2 = await payBlackbytesToWinner(draw);
				await db.query("UPDATE draws SET paid_winner_bb = 1, paid_winner_bb_unit = ? WHERE draw_id = ?", [result2.unit, draw_id]);
			} catch (e) {
				console.error('Error payBlackbytesToWinner: ', e);
				notifications.notifyAdmin('payBlackbytesToWinner failed', e.toString());
			}
		}
		
		if (draw.paid_referrer_bb === 0 && draw.referrer_address) {
			try {
				let result3 = payBlackbytesToReferrer(draw);
				await db.query("UPDATE draws SET paid_referrer_bb = 1, paid_referrer_bb_unit = ? WHERE draw_id = ?", [result3.unit, draw_id]);
			}catch (e) {
				console.error('Error payBlackbytesToReferrer: ', e);
				notifications.notifyAdmin('payBlackbytesToReferrer failed', e.toString());
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
	
	conf.drawDate = moment(conf.drawDate, 'DD.MM.YYYY hh:mm').add(conf.drawInterval, 'days').format('DD.MM.YYYY hh:mm');
	json.drawDate = conf.drawDate;
	fs.writeFile(userConfFile, JSON.stringify(json, null, '\t'), 'utf8', (err) => {
		if (err)
			throw Error('failed to write conf.json: ' + err);
	});
}

async function calcPoints(balance, address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ?", [address]);
	if (!rows.length)
		throw Error("address "+address+" not found");
	
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
	let rows = await db.query("SELECT referrerCode, attested FROM user_addresses JOIN users USING(device_address) WHERE address = ?",
		[address]);
	if (!rows.length || rows[0].attested === 0)
		return null;
	if (!rows[0].referrerCode)
		return null;
	let rows2 = await db.query("SELECT address FROM users JOIN user_addresses USING(device_address) WHERE code = ? AND attested = 1",
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
		let prevDraw = rows[0];
		addressesInfo.hadPreviousDraw = true;
		addressesInfo.prev_winner_address = prevDraw.winner_address;
		addressesInfo.prev_referrer_address = prevDraw.referrer_address || 'none';
		addressesInfo.prev_sum = prevDraw.sum;
		addressesInfo.prev_bitcoin_hash = prevDraw.bitcoin_hash;
		addressesInfo.prev_date = moment(prevDraw.date, 'YYYY-MM-DD hh:mm:ss').format('DD.MM.YYYY hh:mm');
	} else {
		addressesInfo.hadPreviousDraw = false;
	}
	addressesInfo.drawDate = conf.drawDate;
	await ctx.render('index', addressesInfo);
});

async function getAddressesInfoForSite() {
	let sum = new BigNumber(0);
	let total_balance = 0;
	let rows = await db.query("SELECT address, attested, referrerCode, device_address FROM user_addresses JOIN users USING(device_address)");
	let objAddresses = {};
	let addresses = [];
	for(let i = 0; i < rows.length; i++){
		let row = rows[i];
		addresses.push(row.address);
		let userInfo = await getUserInfo(row.device_address);
		objAddresses[row.address] = {
			attested: row.attested,
			points: "0",
			referrerCode: row.referrerCode,
			totalPointsOfReferrals: await getPointsOfReferrals(userInfo.code)
		};
	}
	
	let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
			FROM outputs \n\
			WHERE is_spent=0 AND address IN(" + addresses.map(db.escape).join(', ') + ")  AND asset IS NULL\n\
			GROUP BY address ORDER BY balance DESC");
	for (let i = 0; i < rows1.length; i++) {
		let row = rows1[i];
		let points = (await calcPoints(row.balance, row.address)).points;
		objAddresses[row.address].points = points.toString();
		objAddresses[row.address].balance = row.balance / 1e9;
		sum = sum.add(points);
		total_balance += row.balance;
	}
	sum = sum.toString();
	return {objAddresses, sum, total_balance: total_balance / 1e9};
}

async function updateNewAttestations() {
	let rows = await db.query("SELECT address FROM user_addresses CROSS JOIN attestations USING(address) WHERE attestor_address IN(?) AND attested=0",
		[conf.arrRealNameAttestors]);
	if (rows.length === 0)
		return;
	let new_attested_addresses = rows.map(row => row.address);
	await db.query("UPDATE user_addresses SET attested = 1 WHERE address IN(?)", [new_attested_addresses]);
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
setInterval(updateNewAttestations, 3600*1000);
process.on('unhandledRejection', up => { throw up; });
