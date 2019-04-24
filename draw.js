/*jslint node: true */
'use strict';
const constants = require('ocore/constants.js');
const conf = require('ocore/conf');
const db = require('ocore/db');
const eventBus = require('ocore/event_bus');
const validationUtils = require('ocore/validation_utils');
const headlessWallet = require('headless-obyte');
const crypto = require('crypto');
const BigNumber = require('bignumber.js');
const moment = require('moment');
const desktopApp = require('ocore/desktop_app.js');
const async = require('async');
const fs = require('fs');
const mutex = require('ocore/mutex');
const notifications = require('./notifications');
const gini = require("gini");

const dust_threshold = 0.1; // for Gini coefficients
const whale_threshold = 500;

BigNumber.config({DECIMAL_PLACES: 30, EXPONENTIAL_AT: [-1e+9, 1e9]});

let assocReceivedGreeting = {};
let assocPrevBalances = {};
let assocMaxPrevBalances = {};
let assocReferralsByCode = {};
let assocAddressesByDevice = {};
let assocAttestedByAddress = {};
let assocBalances = {};

function getTextToSign(address){
	return "I confirm that I own the address "+address+" and want it to participate in the draw airdrop.";
}

function getRulesText(){
	return '➡ Real-name attested addresses get 1 point per GB of balance up to '+conf.balanceThreshold1+' GB, plus '+conf.multiplierForAmountAboveThreshold1+' point for each GB between '+conf.balanceThreshold1+' GB and '+conf.balanceThreshold2+' GB, plus '+conf.multiplierForAmountAboveThreshold2+' point for each GB above '+conf.balanceThreshold2+' GB.\n' +
		'➡ Unattested addresses get '+conf.multiplierForNonAttested+' point per GB of balance.\n' +
		'➡ '+conf.multiplierForBalanceIncrease+' point is awarded for each GB of balance increase over the maximum balance in the previous draws, up to a '+conf.maxBalanceIncreaseFactor+'x increase.\n' +
		'➡ '+conf.multiplierForBalanceDecrease+' point is deducted for each GB of balance decrease since the previous draw.';
}

function getGreetingText(){
	return "Welcome to our weekly airdrop!  Every week, a prize of " + (2* conf.rewardForWinnerInBytes / 1e9) + " GB and " + (conf.rewardForWinnerInBlackbytes / 1e9) + " GBB is airdropped to a single winner.  This could be you!  It is like a lottery but you don't have to buy lottery tickets - just prove your existing balance.\n\nYour chance to win depends on the balances of the addresses you link here - the larger the balances, the more points you get.  The winner of the current draw will be selected in a proven random way on " + conf.drawDate + " UTC. The more points you have on this date, the higher your chance of winning.\n\nThe rules are designed in favor of smaller participants.  Balances of more than "+conf.balanceThreshold1+" GB add less points than balances of less than "+conf.balanceThreshold1+" GB.  To get more points, you may pass a real name attestation - find \"Real name attestation bot\" in the Bot Store. The draw bot won't see your personal details, only the fact that you are attested.  Steem attestation with reputation over "+conf.minSteemReputation+" also qualifies.  Full rules:\n" + getRulesText() + "\n\nIf you refer new users to this draw and one of them wins, you also win " + (conf.rewardForReferrerInBytes / 1e9) + " GB and " + (conf.rewardForReferrerInBlackbytes / 1e9) + " GBB.  Instructions will be shown after you link your own address.\n\nPlease send me the address of your wallet you want to enter in the weekly draw (click '...' and 'Insert my address').";
}

function sendGreeting(device_address){
	const device = require('ocore/device.js');
	device.sendMessageToDevice(device_address, 'text', getGreetingText());
	assocReceivedGreeting[device_address] = true;
}

let myAddress;

eventBus.once('headless_wallet_ready', async () => {
	const network = require('ocore/network.js');
	headlessWallet.setupChatEventHandlers();
	
	db.query("SELECT address FROM my_addresses", [], function (rows) {
		if (rows.length === 0)
			throw Error("no addresses");
		myAddress = rows[0].address;
	});
	
	let rows = await db.query("SELECT device_address, referrerCode FROM users WHERE referrerCode IS NOT NULL");
	rows.forEach(row => {
		if (!assocReferralsByCode[row.referrerCode])
			assocReferralsByCode[row.referrerCode] = [];
		assocReferralsByCode[row.referrerCode].push(row.device_address);
	});
	
	rows = await db.query("SELECT device_address, address FROM user_addresses");
	rows.forEach(row => {
		if (!assocAddressesByDevice[row.device_address])
			assocAddressesByDevice[row.device_address] = [];
		assocAddressesByDevice[row.device_address].push(row.address);
	});
	network.setWatchedAddresses(rows.map(row => row.address));
	
	rows = await db.query("SELECT attested, address FROM user_addresses WHERE attested=1");
	rows.forEach(row => {
		assocAttestedByAddress[row.address] = row.attested;
	});
	
	setInterval(retryPayments, conf.payoutCheckInterval);
	
	eventBus.on('paired', async (from_address, pairing_secret) => {
		let referring_user = await getUserByCode(pairing_secret);
		if (referring_user) {
			await createUser(from_address);
			if (referring_user.code !== pairing_secret) {
				await setRefCode(from_address, pairing_secret);
			}
		}
		sendGreeting(from_address);
	});
	
	eventBus.on('text', async (from_address, text) => {
		const device = require('ocore/device.js');
		text = text.trim();
		// ignore multi-line bot responses
		if (text.split("\n").length > 1)
			return false;
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
			let validation = require('ocore/validation.js');
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
				let addressInfo = await getAddressInfo(address);
				if (addressInfo) {
					return device.sendMessageToDevice(from_address, 'text', (addressInfo.device_address === from_address) ? 'This address is already added and is participating in the draw.' : 'This address is already registered by another user.');
				}
				let attested = await saveAddress(from_address, address);
				device.sendMessageToDevice(from_address, 'text', "Thanks, added your address.  "+(attested ? "The address is attested and will earn you the maximum number of points." : "The address is not attested and will earn you "+(conf.multiplierForNonAttested)+" points per GB of balance.  Have your real name attested to maximize your points and chances to win.  Steem attestation with reputation over "+conf.minSteemReputation+" also qualifies."));
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
			await showStatus(from_address, userInfo);
		} else if (userInfo && text === 'change ref') {
			await setStep(from_address, 'ref');
			device.sendMessageToDevice(from_address, 'text', "Who invited you? Please send me his/her referrer code. Or [skip](command:skip ref) this step. If you win, the referrer will also win an additional prize.");
		} else if (userInfo && text === 'ref') {
			let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND attested = 1", [from_address]);
			if (rows.length) {
				const invite_code = device.getMyDevicePubKey() + '@' + conf.hub + '#' + userInfo.code;
				const qr_url = conf.site + "/qr/?code=" + encodeURIComponent("byteball:"+ invite_code);
				return device.sendMessageToDevice(from_address, 'text', 'If you refer new users and one of them wins, you also win ' + (conf.rewardForReferrerInBytes / 1e9) + ' GB and ' + (conf.rewardForReferrerInBlackbytes / 1e9) + ' GBB. There are three ways to invite new users and ensure that the referrals are tracked to you:\n➡ have new users scan this QR code with wallet app ' + qr_url + ' which opens this bot in the user\'s wallet;\n➡ have new users copy-paste this to \"Chat > Add a new device > Accept invitation from the other device ' + invite_code + ' which opens this bot in the user\'s wallet;\n ➡ have new users start this bot from the Bot Store and enter your referrer code ' + userInfo.code + ' when the bot asks them about the referrer.');
			} else {
				return device.sendMessageToDevice(from_address, 'text', 'To participate in the referral program you need to link at least one real-name attested address.  If you are not attested yet, find "Real name attestation bot" in the Bot Store and go through the attestation.  If you are already attested, switch to your attested wallet and [link its address](command:add new address).  The Draw Airdrop Bot will not know any of your personal details, it needs just the fact that you are attested.  Steem attestation with reputation over '+conf.minSteemReputation+' also qualifies.');
			}
		} else if (userInfo && userInfo.step === 'ref') {
			if (userInfo.code === text) return device.sendMessageToDevice(from_address, 'text', 'You can\'t refer yourself');
			let user = await getUserByCode(text);
			if (user) {
				await setRefCode(from_address, text);
				await showStatus(from_address, userInfo);
				// notify the referrer
				let total_user_balance = await getUserBalance(from_address);
				device.sendMessageToDevice(user.device_address, 'text', 'A new user with balance '+(total_user_balance/1e9)+' GB has just joined the draw under your referral code.');
			} else {
				device.sendMessageToDevice(from_address, 'text', 'Please send a valid referrer code or [skip](command:skip ref)');
			}
		} else if (userInfo) {
			await showStatus(from_address, userInfo);
		}
	});
});

async function showStatus(device_address, userInfo) {
	const device = require('ocore/device');
	let addressesRows = await getAddresses(device_address);
	let sum = new BigNumber(0);
	let text = '';
	for (let i = 0; i < addressesRows.length; i++) {
		let address = addressesRows[i].address;
		let attested = addressesRows[i].attested;
		let objPoints = await calcPoints(await getAddressBalance(address), address, attested);
		text += address + '\n(' + (attested ? 'attested' : 'non-attested') + '), points: ' + objPoints.points + '\n' +
			(objPoints.pointsForBalanceAboveThreshold2.toNumber() > 0 ?
				'\t' + objPoints.pointsForBalanceAboveThreshold2.toString() + ' points for balance above ' + conf.balanceThreshold2 + ' GB\n' : '') +
			(objPoints.pointsForBalanceAboveThreshold1.toNumber() > 0 ?
				'\t' + objPoints.pointsForBalanceAboveThreshold1.toString() + ' points for balance above ' + conf.balanceThreshold1 + ' GB\n' : '') +
			(objPoints.pointsForBalanceBelowThreshold1.toNumber() > 0 ?
				'\t' + objPoints.pointsForBalanceBelowThreshold1.toString() + ' points for balance below ' + conf.balanceThreshold1 + ' GB\n' : '') +
			(objPoints.pointsForChange.toNumber() ?
				'\t' + objPoints.pointsForChange.toString() + ' points for balance change from the previous draw\n' : '') +
			'';
		sum = sum.plus(objPoints.points);
	}
	let totalPointsOfReferrals = await getPointsOfReferrals(userInfo.code);
	device.sendMessageToDevice(device_address, 'text', 'Your points: ' + sum.toString() + '\nTotal points of your referrals: ' + totalPointsOfReferrals +
		'\n\nLinked addresses:\n' + text +
		'\nChances to win are proportional to the points you have. Current rules:\n' +
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
	if (!assocAddressesByDevice[device_address])
		assocAddressesByDevice[device_address] = [];
	assocAddressesByDevice[device_address].push(user_address);
	const network = require('ocore/network');
	network.addWatchedAddress(user_address);
	
	let rows = await db.query("SELECT device_address FROM users WHERE device_address = ?", [device_address]);
	if (!rows.length) {
		await createUser(device_address);
	}
	let attested = 0;
	let attested_user_id = null;
	// check real name attestation first
	let att_rows = await db.query("SELECT `value` FROM attested_fields WHERE attestor_address IN(?) AND address=? AND `field`='user_id'", [conf.arrRealNameAttestors, user_address]);
	if (att_rows.length > 0){
		attested = 1;
		attested_user_id = att_rows[0].value;
	}
	if (!attested){ // try steem
		let att_rows = await db.query(
			"SELECT payload FROM attestations CROSS JOIN messages USING(unit, message_index) WHERE attestor_address IN(?) AND address=?",
			[conf.arrSteemAttestors, user_address]);
		att_rows.forEach(att_row => {
			let payload = JSON.parse(att_row.payload);
			if (payload.profile.reputation < conf.minSteemReputation)
				return;
			attested = 1;
			attested_user_id = payload.profile.user_id;
		});
	}
	if (attested){ // check if same user_id is already registered
		let dup_rows = await db.query("SELECT 1 FROM user_addresses WHERE attested_user_id=?", [attested_user_id]);
		if (dup_rows.length > 0){
			attested = 0;
			attested_user_id = null;
		}
	}
	assocAttestedByAddress[user_address] = attested;
	await db.query("INSERT " + db.getIgnore() + " INTO user_addresses (device_address, address, attested, attested_user_id) VALUES (?,?,?,?)", [device_address, user_address, attested, attested_user_id]);
	
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
	if (code){
		if (!assocReferralsByCode[code])
			assocReferralsByCode[code] = [];
		assocReferralsByCode[code].push(device_address);
	}
	return new Promise(resolve => {
		db.query("UPDATE users SET referrerCode = ?, step = ? WHERE device_address = ?", [code, 'done', device_address], () => {
			return resolve();
		})
	});
}

async function getAddressBalance(address) {
	if (assocBalances[address] !== undefined)
		return assocBalances[address];
	let rows = await db.query(
		"SELECT SUM(amount) AS balance \n\
		FROM outputs JOIN units USING(unit) \n\
		WHERE is_spent=0 AND address=? AND sequence='good' AND asset IS NULL", [address]);
	assocBalances[address] = rows.length ? (rows[0].balance || 0) : 0;
	return assocBalances[address];
}

async function getUserBalance(device_address) {
	let rows = await db.query(
		"SELECT SUM(amount) AS balance \n\
		FROM user_addresses CROSS JOIN outputs USING(address) CROSS JOIN units USING(unit) \n\
		WHERE device_address=? AND is_spent=0 AND sequence='good' AND asset IS NULL", [device_address]);
	if (rows.length) {
		return (rows[0].balance || 0);
	} else {
		return 0;
	}
}

async function getPointsOfReferrals(code) {
	let arrReferredDevices = assocReferralsByCode[code];
	if (!arrReferredDevices)
		return "0";
	let sum = new BigNumber(0);
	for (let j=0; j<arrReferredDevices.length; j++){
		let device_address = arrReferredDevices[j];
		let arrAddresses = assocAddressesByDevice[device_address];
		if (!arrAddresses){
			console.error("ref code "+code+", device "+device_address+": no addresses");
			continue;
		}
		for (let i=0; i<arrAddresses.length; i++){
			let address = arrAddresses[i];
			let balance = await getAddressBalance(address);
			let points = (await calcPoints(balance, address, assocAttestedByAddress[address])).points;
			if (points.gt(0))
				sum = sum.plus(points);
		}
	}
/*	let rows = await db.query(
		"SELECT address, attested, SUM(amount) AS balance \n\
		FROM users CROSS JOIN user_addresses USING(device_address) CROSS JOIN outputs USING(address) CROSS JOIN units USING(unit)\n\
		WHERE referrerCode = ? AND is_spent=0 AND sequence='good' AND asset IS NULL \n\
		GROUP BY address", [code]);
	
	for (let i = 0; i < rows.length; i++) {
		let row = rows[i];
		let points = (await calcPoints(row.balance, row.address, row.attested)).points;
		if (points.gt(0)) {
			sum = sum.plus(points);
		}
	}*/
	return sum.toString();
}

setInterval(async () => {
	if (moment() > moment(conf.drawDate, 'DD.MM.YYYY hh:mm')) {
		updateNextRewardInConf();
		await updateNewAttestations();
		assocBalances = {}; // reset the cache
		let arrPoints = [];
		let sum_points = new BigNumber(0);
		let sum_balances = 0;
		let rows3 = await db.query("SELECT address FROM user_addresses WHERE excluded=0");
		let assocAddressesToBalance = {};
		let assocAddressesToPoints = {};
		rows3.forEach(row => {
			assocAddressesToBalance[row.address] = 0;
			assocAddressesToPoints[row.address] = new BigNumber(0);
		});
		let rows1 = await db.query("SELECT address, attested, SUM(amount) AS balance\n\
				FROM user_addresses CROSS JOIN outputs USING(address) CROSS JOIN units USING(unit)\n\
				WHERE is_spent=0 AND sequence='good' AND asset IS NULL AND excluded=0 \n\
				GROUP BY address", []);

		for (let i = 0; i < rows1.length; i++) {
			let row = rows1[i];
			assocAddressesToBalance[row.address] = row.balance;
			let points = (await calcPoints(row.balance, row.address, row.attested)).points;
			if (points.gt(0)) {
				assocAddressesToPoints[row.address] = points;
				arrPoints.push({address: row.address, points});
				sum_points = sum_points.plus(points);
			}
			sum_balances += row.balance;
		}
		if (sum_points.eq(new BigNumber(0)))
			return;
		
		let hash_rows = await db.query("SELECT value FROM data_feeds CROSS JOIN units USING(unit) CROSS JOIN unit_authors USING(unit) \n\
			WHERE address = ? AND +feed_name='bitcoin_hash' AND sequence='good' AND is_stable=1 ORDER BY data_feeds.rowid DESC LIMIT 1", [conf.oracle]);
		
		let bitcoin_hash = hash_rows[0].value;
		
		// 1. winner by points
		let hash = crypto.createHash('sha256').update(bitcoin_hash).digest('hex');
		let number = new BigNumber(hash, 16);
		let random = (number.div(new BigNumber(2).pow(256))).times(sum_points);
		
		let sum2 = new BigNumber(0);
		let winner_address;
		for (let i = 0; i < arrPoints.length; i++) {
			sum2 = sum2.plus(arrPoints[i].points);
			if (random.lte(sum2)) {
				winner_address = arrPoints[i].address;
				break;
			}
		}
		let referrer_address = await getReferrerFromAddress(winner_address);
		let rows2 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [winner_address]);
		let winner_device_address = rows2[0].device_address;
		let referrer_device_address = null;
		if (referrer_address) {
			let rows3 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [referrer_address]);
			referrer_device_address = rows3[0].device_address;
		}
		
		// 2. winner by balances
		let bal_hash = crypto.createHash('sha256').update(hash).digest('hex');
		let bal_number = new BigNumber(bal_hash, 16);
		let bal_random = (bal_number.div(new BigNumber(2).pow(256))).times(sum_balances);
		
		let bal_sum2 = 0;
		let balance_winner_address;
		for (let i = 0; i < rows1.length; i++) {
			bal_sum2 += rows1[i].balance;
			if (bal_random.lte(bal_sum2)) {
				balance_winner_address = rows1[i].address;
				break;
			}
		}
		let balance_referrer_address = await getReferrerFromAddress(balance_winner_address);
		rows2 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [balance_winner_address]);
		let balance_winner_device_address = rows2[0].device_address;
		let balance_referrer_device_address = null;
		if (balance_referrer_address) {
			let rows3 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [balance_referrer_address]);
			balance_referrer_device_address = rows3[0].device_address;
		}
		
		// insert the draw
		let insertMeta = await db.query(
			"INSERT INTO draws (bitcoin_hash, winner_address, referrer_address, balance_winner_address, balance_referrer_address, sum) \n\
			VALUES (?, ?,?, ?,?, ?)",
			[bitcoin_hash, winner_address, referrer_address, balance_winner_address, balance_referrer_address, sum_points.toNumber()]);
		let draw_id = insertMeta.insertId;
		
		await new Promise(resolve => {
			let arrQueries = [];
			db.takeConnectionFromPool(function (conn) {
				conn.addQuery(arrQueries, "BEGIN");
				rows1.forEach(row => {
					conn.addQuery(arrQueries, "INSERT INTO prev_balances (draw_id, address, balance, points) VALUES (?,?,?,?)",
						[draw_id, row.address, assocAddressesToBalance[row.address], assocAddressesToPoints[row.address].toString()]);
				});
				conn.addQuery(arrQueries, "COMMIT");
				async.series(arrQueries, () => {
					conn.release();
					resolve();
				});
			});
		});
		assocPrevBalances = {};
		assocMaxPrevBalances = {};
		pay(draw_id);
		
		// send notifivations
		let device = require('ocore/device');
		let rows = await db.query("SELECT device_address FROM users");
		rows.forEach(row => {
			device.sendMessageToDevice(
				row.device_address, 'text',
				'The King of Goldfish in the draw #'+draw_id+' is ' + winner_address +
				(winner_device_address === row.device_address ? ' (you)' : '') + ' and the winner receives a prize of '+(conf.rewardForWinnerInBytes/1e9)+' GB and '+(conf.rewardForWinnerInBlackbytes/1e9)+' GBB, congratulations to the winner!' +
				(referrer_address !== null
				? '\n\nThe winner was referred by ' + referrer_address + (referrer_device_address === row.device_address ? ' (you)' : '') + ' and the referrer receives a prize of '+(conf.rewardForReferrerInBytes/1e9)+' GB and '+(conf.rewardForReferrerInBlackbytes/1e9)+' GBB, congratulations to the winner\'s referrer!'
				: '') +
				'\n\n' +
				'The Prince of Whales in the draw #'+draw_id+' is ' + balance_winner_address +
				(balance_winner_device_address === row.device_address ? ' (you)' : '') + ' and the winner receives a prize of '+(conf.rewardForWinnerInBytes/1e9)+' GB and '+(conf.rewardForWinnerInBlackbytes/1e9)+' GBB, congratulations to the winner!' +
				(balance_referrer_address !== null
				? '\n\nThe winner was referred by ' + balance_referrer_address + (balance_referrer_device_address === row.device_address ? ' (you)' : '') + ' and the referrer receives a prize of '+(conf.rewardForReferrerInBytes/1e9)+' GB and '+(conf.rewardForReferrerInBlackbytes/1e9)+' GBB, congratulations to the winner\'s referrer!'
				: '') +
				'\n\nThe next draw is scheduled for '+conf.drawDate+' UTC.  You can increase your chances to win by increasing the balance you linked or referring new users.  See the [details](command:status).'
			);
		});
	}
}, 60000);


async function retryPayments(){
	let rows = await db.query(
		"SELECT draw_id FROM draws \n\
		WHERE \n\
			paid_bytes = 0 OR paid_winner_bb = 0 \n\
			OR (paid_balance_winner_bb = 0 AND balance_winner_address IS NOT NULL) \n\
			OR (paid_referrer_bb = 0 AND referrer_address IS NOT NULL) \n\
			OR (paid_balance_referrer_bb = 0 AND balance_referrer_address IS NOT NULL) \n\
		"
	);
	rows.forEach(row => {
		pay(row.draw_id);
	})
};

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
				let result = await payBlackbytes(draw.winner_address, conf.rewardForWinnerInBlackbytes);
				await db.query("UPDATE draws SET paid_winner_bb = 1, paid_winner_bb_unit = ? WHERE draw_id = ?", [result.unit, draw_id]);
			} catch (e) {
				console.error('Error payBlackbytesToWinner: ', e);
				notifications.notifyAdmin('payBlackbytesToWinner failed', e.toString());
			}
		}
		
		if (draw.paid_referrer_bb === 0 && draw.referrer_address) {
			try {
				let result = await payBlackbytes(draw.referrer_address, conf.rewardForReferrerInBlackbytes);
				await db.query("UPDATE draws SET paid_referrer_bb = 1, paid_referrer_bb_unit = ? WHERE draw_id = ?", [result.unit, draw_id]);
			}catch (e) {
				console.error('Error payBlackbytesToReferrer: ', e);
				notifications.notifyAdmin('payBlackbytesToReferrer failed', e.toString());
			}
		}
		
		if (draw.paid_balance_winner_bb === 0 && draw.balance_winner_address) {
			try {
				let result = await payBlackbytes(draw.balance_winner_address, conf.rewardForWinnerInBlackbytes);
				await db.query("UPDATE draws SET paid_balance_winner_bb = 1, paid_balance_winner_bb_unit = ? WHERE draw_id = ?", [result.unit, draw_id]);
			} catch (e) {
				console.error('Error payBlackbytesToWinner balance : ', e);
				notifications.notifyAdmin('payBlackbytesToWinner balance failed', e.toString());
			}
		}
		
		if (draw.paid_balance_referrer_bb === 0 && draw.balance_referrer_address) {
			try {
				let result = await payBlackbytes(draw.balance_referrer_address, conf.rewardForReferrerInBlackbytes);
				await db.query("UPDATE draws SET paid_balance_referrer_bb = 1, paid_balance_referrer_bb_unit = ? WHERE draw_id = ?", [result.unit, draw_id]);
			}catch (e) {
				console.error('Error payBlackbytesToReferrer balance: ', e);
				notifications.notifyAdmin('payBlackbytesToReferrer balance failed', e.toString());
			}
		}
		
		unlock();
	});
}

function payBytes(row) {
	let outputs = [
		{address: row.winner_address, amount: conf.rewardForWinnerInBytes},
		{address: row.balance_winner_address, amount: conf.rewardForWinnerInBytes},
	];
	if (row.referrer_address !== null)
		outputs.push({address: row.referrer_address, amount: conf.rewardForReferrerInBytes});
	if (row.balance_referrer_address !== null)
		outputs.push({address: row.balance_referrer_address, amount: conf.rewardForReferrerInBytes});
	
	return headlessWallet.sendPaymentUsingOutputs('base', outputs, myAddress);
}

async function payBlackbytes(address, amount) {
	let rows = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [address]);
	return headlessWallet.sendAssetFromAddress(constants.BLACKBYTES_ASSET, amount, myAddress, address, rows[0].device_address);
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

async function calcPoints(balance, address, attested) {
//	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ?", [address]);
//	if (!rows.length)
//		throw Error("address "+address+" not found");
	
	let bnBalance = new BigNumber(balance).div(conf.unitValue);
	let bnThreshold1 = new BigNumber(conf.balanceThreshold1);
	let bnThreshold2 = new BigNumber(conf.balanceThreshold2);
	let threshold1InBytes = conf.balanceThreshold1 * conf.unitValue;
	let threshold2InBytes = conf.balanceThreshold2 * conf.unitValue;
	let pointsForBalanceAboveThreshold2 = new BigNumber(0);
	let pointsForBalanceAboveThreshold1 = new BigNumber(0);
	let pointsForBalanceBelowThreshold1 = new BigNumber(0);
	let points = new BigNumber(0);
	let pointsForChange = new BigNumber(0);
	if (attested) {
		if (balance > threshold2InBytes) {
			pointsForBalanceAboveThreshold2 = bnBalance.minus(bnThreshold2).times(conf.multiplierForAmountAboveThreshold2);
			pointsForBalanceAboveThreshold1 = bnThreshold2.minus(bnThreshold1).times(conf.multiplierForAmountAboveThreshold1);
			pointsForBalanceBelowThreshold1 = bnThreshold1;
		} else if (balance > threshold1InBytes) {
			pointsForBalanceAboveThreshold1 = bnBalance.minus(bnThreshold1).times(conf.multiplierForAmountAboveThreshold1);
			pointsForBalanceBelowThreshold1 = bnThreshold1;
		} else {
			pointsForBalanceBelowThreshold1 = bnBalance;
		}
		points = pointsForBalanceBelowThreshold1.plus(pointsForBalanceAboveThreshold1).plus(pointsForBalanceAboveThreshold2);
	} else {
		points = bnBalance.times(conf.multiplierForNonAttested);
	}
	let prev_balance = await getPrevBalance(address);
	let max_prev_balance = await getMaxPrevBalance(address);
	if (max_prev_balance && balance > max_prev_balance) {
		let deltaInGB;
		if (balance < conf.maxBalanceIncreaseFactor * max_prev_balance)
			deltaInGB = bnBalance.minus(new BigNumber(max_prev_balance).div(conf.unitValue));
		else
			deltaInGB = new BigNumber(max_prev_balance).times(conf.maxBalanceIncreaseFactor - 1).div(conf.unitValue);
		pointsForChange = deltaInGB.times(conf.multiplierForBalanceIncrease);
		points = points.plus(pointsForChange);
	}
	if (prev_balance && balance < prev_balance) {
		let deltaInGB = bnBalance.minus(new BigNumber(prev_balance).div(conf.unitValue));
		pointsForChange = deltaInGB.times(conf.multiplierForBalanceDecrease);
		points = points.plus(pointsForChange);
	}
	return {points: points, pointsForBalanceAboveThreshold2, pointsForBalanceAboveThreshold1, pointsForBalanceBelowThreshold1, pointsForChange};
}

async function getPrevBalance(address){
	if (assocPrevBalances[address] !== undefined)
		return assocPrevBalances[address];
	let rows = await db.query("SELECT balance FROM prev_balances WHERE address = ? AND draw_id=(SELECT draw_id FROM draws ORDER BY draw_id DESC LIMIT 1)", [address]);
	assocPrevBalances[address] = rows.length ? rows[0].balance : null;
	return assocPrevBalances[address];
}

async function getMaxPrevBalance(address){
	if (assocMaxPrevBalances[address] !== undefined)
		return assocMaxPrevBalances[address];
	let rows = await db.query("SELECT MAX(balance) AS max_balance FROM prev_balances WHERE address = ?", [address]);
	assocMaxPrevBalances[address] = rows.length ? rows[0].max_balance : null;
	return assocMaxPrevBalances[address];
}

async function getReferrerFromAddress(address) {
	let rows = await db.query("SELECT referrerCode, attested FROM user_addresses JOIN users USING(device_address) WHERE address = ?",
		[address]);
	if (rows.length === 0)
		throw Error("address "+address+" not found");
	if (!rows[0].referrerCode)
		return null;
	if (rows[0].attested === 0){
		notifications.notifyAdmin("referral not attested", "referral "+address+" is not attested");
	//	return null;
	}
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
const KoaRouter = require('koa-router');
const router = new KoaRouter();

router.get('*/snapshot/:id?', async (ctx) => {
	try {
		let draws = [];
		if (ctx.params.id)
			draws = await db.query("SELECT * FROM draws WHERE draw_id=?;", [ctx.params.id]);
		else
			draws = await db.query("SELECT * FROM draws ORDER BY draw_id DESC LIMIT 1;");

		if (!draws.length) throw Error("no draw");
		let rows = await db.query("SELECT `address`, `balance`, `points` FROM prev_balances WHERE draw_id=? ORDER BY address ASC;", [draws[0].draw_id]);

		ctx.body = {
			status: 'success',
			draw: draws[0],
			data: rows
		};
	} catch (err) {
		ctx.body = {
			status: 'error',
			draw: {},
			data: []
		};
		console.error(err);
	}
})
app.use(router.routes());

app.use(views(__dirname + '/views', {
	map: {
		html: 'ejs'
	}
}));

app.use(async (ctx, next) => {
	try {
		await next();
	} catch (err) {
		console.error(new Error(err), err);
		notifications.notifyAdmin('Error in koa', err.toString()+'\n'+err.stack);
		process.exit(0);
	}
});

app.use(async ctx => {
	let rows = await db.query("SELECT * FROM draws ORDER BY date DESC LIMIT 1");
	let addressesInfo = await getAddressesInfoForSite();
	if (rows.length) {
		let prevDraw = rows[0];
		addressesInfo.hadPreviousDraw = true;
		addressesInfo.prevDraw = prevDraw;
		addressesInfo.prev_date = moment(prevDraw.date, 'YYYY-MM-DD hh:mm:ss').format('DD.MM.YYYY hh:mm');
	} else {
		addressesInfo.hadPreviousDraw = false;
	}
	addressesInfo.conf = conf;
	let time = process.hrtime();
	await ctx.render('index', addressesInfo);
	let render_time = getTimeElapsed(time);
	console.error("render "+render_time+"s");
});

async function getAddressesInfoForSite() {
	let sum = new BigNumber(0);
	let total_balance = 0;
	let rows = await db.query("SELECT address, attested, code, referrerCode FROM user_addresses JOIN users USING(device_address) WHERE excluded=0");
	let objAddresses = {};
	let addresses = [];
	for(let i = 0; i < rows.length; i++){
		let row = rows[i];
		addresses.push(row.address);
		objAddresses[row.address] = {
			attested: row.attested,
			points: new BigNumber(0),
			pointsForChange: new BigNumber(0),
			balance: 0,
			referrerCode: row.referrerCode,
			totalPointsOfReferrals: row.attested ? (await getPointsOfReferrals(row.code)) : 0
		};
	}
	
	let arrPoints = [];
	let arrBalances = [];
	let whale_sum = new BigNumber(0);
	let points_time = 0;
	let calc_time = 0;
	for (let i = 0; i < rows.length; i++) {
		let row = rows[i];
		let time = process.hrtime();
		let balance = await getAddressBalance(row.address);
		let objPoints = await calcPoints(balance, row.address, row.attested);
		let points = objPoints.points;
		points_time += getTimeElapsed(time);
		time = process.hrtime();
		let nPoints = points.toNumber();
		objAddresses[row.address].points = points.toString();
		objAddresses[row.address].pointsForChange = objPoints.pointsForChange.toString();
		let gb_balance = balance / 1e9;
		objAddresses[row.address].balance = gb_balance;
		if (nPoints > 0)
			sum = sum.plus(points);
		total_balance += balance;
		if (gb_balance > dust_threshold)
			arrBalances.push(gb_balance);
		if (nPoints > dust_threshold)
			arrPoints.push(nPoints);
		if (gb_balance > whale_threshold && nPoints > 0)
			whale_sum = whale_sum.plus(points);
		calc_time += getTimeElapsed(time);
	}
	let time = process.hrtime();
	let balance_gini = Object.keys(arrBalances).length ? gini.ordered(arrBalances.sort((a, b) => a - b)) : NaN;
	let points_gini = Object.keys(arrPoints).length ? gini.ordered(arrPoints.sort((a, b) => a - b)) : NaN;
	let gini_time = getTimeElapsed(time);
	time = process.hrtime();
//	let whale_dominance = whale_sum.div(sum).times(new BigNumber(100)).toFixed(2);
	let whale_dominance = (whale_sum.toNumber()/sum.toNumber()*100).toFixed(2);
	let whale_time = getTimeElapsed(time);
	console.error("points "+points_time+"s, calc "+calc_time+"s, gini "+gini_time+"s, whale "+whale_time+"s");
	sum = sum.toString();
	return {objAddresses, sum, total_balance: total_balance / 1e9, balance_gini, points_gini, dust_threshold, whale_dominance, whale_threshold};
}

function getTimeElapsed(time){
	let diff = process.hrtime(time);
	return diff[0] + diff[1]/1e9;
}

async function updateNewAttestations() {
	let rows = await db.query(
		"SELECT address, `value`, attestor_address, payload \n\
		FROM user_addresses CROSS JOIN attested_fields USING(address) CROSS JOIN messages USING(unit, message_index) \n\
		WHERE attested=0 AND attestor_address IN(?) AND `field`='user_id' \n\
			AND NOT EXISTS (SELECT 1 FROM user_addresses WHERE attested_user_id=`value`)",
		[conf.arrRealNameAttestors.concat(conf.arrSteemAttestors)]);
	console.log(rows.length+" new attestations");
	if (rows.length === 0)
		return;
	let assocUsedUserIds = {};
	rows.forEach(row => {
		if (assocUsedUserIds[row.value])
			return;
		if (conf.arrSteemAttestors.includes(row.attestor_address)){
			let payload = JSON.parse(row.payload);
			if (payload.profile.user_id !== row.value)
				throw Error("user_id mismatch");
			if (payload.profile.reputation < conf.minSteemReputation)
				return;
		}
		assocUsedUserIds[row.value] = true;
		assocAttestedByAddress[row.address] = 1;
		db.query("UPDATE user_addresses SET attested = 1, attested_user_id=? WHERE address=?", [row.value, row.address]);
	});
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

eventBus.on('new_my_transactions', async (arrUnits) => {
	let rows = await db.query(
		"SELECT address FROM unit_authors CROSS JOIN user_addresses USING(address) WHERE unit IN(?) \n\
		UNION \n\
		SELECT address FROM outputs CROSS JOIN user_addresses USING(address) WHERE unit IN(?) AND asset IS NULL",
		[arrUnits, arrUnits]);
	// reset cache of affected addresses
	rows.forEach(row => {
		delete assocBalances[row.address];
	});
});

app.listen(conf.webPort);
setInterval(updateNewAttestations, 3600*1000);
process.on('unhandledRejection', up => { throw up; });
