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
			await setRefRegCode(from_address, pairing_secret);
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
			let exists = await existsAddress(text);
			if (exists) {
				device.sendMessageToDevice(from_address, 'text', 'Address already in use');
			} else {
				await saveAddress(from_address, text);
				await setStep(from_address, 'sign');
				return device.sendMessageToDevice(from_address, 'text', 'I save your address. \n' + textSign());
			}
		} else if (!userInfo || !addressesRows.length || text === 'addNewAddress') {
			return device.sendMessageToDevice(from_address, 'text', 'Please send me your address');
		} else if (text === 'skipRef') {
			await setRefRegCode(from_address, '-');
			await setStep(from_address, 'go');
			await sendGo(from_address, userInfo);
		} else if (text === 'ref') {
			let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND attested = 1", [from_address]);
			if (rows.length) {
				device.sendMessageToDevice(from_address, 'text', 'To attract referrals, use your code: ' + userInfo.refCode +
					'\nor pairing code:');
				return device.sendMessageToDevice(from_address, 'text', device.getMyDevicePubKey() + '@' + conf.hub + '#' + userInfo.refCode);
			} else {
				return device.sendMessageToDevice(from_address, 'text', 'To participate in the referral program you must have at least 1 attested address');
			}
		} else if (userInfo.step === 'ref') {
			let user = await getUserByCode(text);
			if (user) {
				await setRefRegCode(from_address, text);
				await sendGo(from_address, 'go');
			} else {
				device.sendMessageToDevice(from_address, 'text', 'Please send valid ref code or [skip](command:skipRef)');
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
				if (objSignedMessage.signed_message !== "sign")
					return device.sendMessageToDevice(from_address, 'text', "You signed a wrong message: " +
						objSignedMessage.signed_message + ", expected: " + "sign");
				if (!(await itsAddress(from_address, objSignedMessage.authors[0].address)))
					return device.sendMessageToDevice(from_address, 'text', "You signed the message with a wrong address: " +
						objSignedMessage.authors[0].address);
				await saveSigned(from_address, objSignedMessage.authors[0].address);
				if (userInfo.referrerRefCode) {
					await setStep(from_address, 'go');
					await sendGo(from_address, userInfo);
				} else {
					await setStep(from_address, 'ref');
					device.sendMessageToDevice(from_address, 'text', "Who invited you? Please send me his(her) ref code. Or [skip](command:skipRef)");
				}
			});
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
			(objPoints.greatNextCalc.toNumber() > 0 ?
				objPoints.greatNextCalc.toString() + ' points for sum more ' + conf.amountForNextCalc + ' gb\n' : '') +
			(objPoints.lessNextCalc.toNumber() > 0 ?
				objPoints.lessNextCalc.toString() + ' points for sum less ' + conf.amountForNextCalc + ' gb\n' : '') +
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
	return 'Please prove ownership of your address by signing a message: [message](sign-message-request:sign)';
}

function getUserInfo(device_address) {
	return new Promise(resolve => {
		db.query("SELECT refCode, referrerRefCode, step FROM users WHERE device_address = ?", [device_address], rows => {
			if (rows) {
				return resolve(rows[0]);
			} else {
				return resolve(null);
			}
		});
	});
}

async function getAddresses(device_address) {
	return await db.query("SELECT * FROM user_addresses WHERE device_address = ? ", [device_address]);
}

async function itsAddress(device_address, address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE device_address = ? AND address = ?", [device_address, address]);
	return !!rows.length;
}

async function saveAddress(device_address, user_address) {
	let rows = await db.query("SELECT device_address FROM users WHERE device_address = ?", [device_address]);
	let balance = await getAddressBalance(user_address);
	if (!rows.length) {
		let refCode = makeCode();
		while ((await db.query("SELECT refCode FROM users WHERE refCode = ?", [refCode])).length) {
			refCode = makeCode();
		}
		await db.query("INSERT INTO users (device_address, refCode) values (?,?)", [device_address, refCode]);
		await db.query("INSERT INTO user_addresses (device_address, address,prevBalance) values (?,?,?)", [device_address, user_address, balance]);
	} else {
		await db.query("INSERT " + db.getIgnore() + " INTO user_addresses (device_address, address, balance) values (?,?,?)",
			[device_address, user_address, balance]);
	}
}

async function saveSigned(device_address, address) {
	await db.query("UPDATE user_addresses SET signed = 1 WHERE device_address = ? AND address = ?", [device_address, address]);
	return true;
}

function getUserByCode(code) {
	return new Promise(resolve => {
		db.query("SELECT * FROM users WHERE refCode = ?", [code], rows => {
			if (rows.length) {
				return resolve(rows[0]);
			} else {
				return resolve(null);
			}
		})
	});
}

function setRefRegCode(device_address, code) {
	return new Promise(resolve => {
		db.query("UPDATE users SET referrerRefCode = ? WHERE device_address = ?", [code, device_address], () => {
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
		let rows1 = await db.query("SELECT address, SUM(amount) AS balance\n\
				FROM outputs JOIN units USING(unit)\n\
				WHERE is_spent=0 AND address IN(SELECT address FROM user_addresses WHERE signed = 1) AND sequence='good' AND asset IS NULL\n\
				GROUP BY address", []);
		
		for (let i = 0; i < rows1.length; i++) {
			let row = rows1[i];
			let points = (await calcPoints(row.balance, row.address)).total;
			if (points.gt(0)) {
				arrPoints[i] = {address: row.address, points};
				sum = sum.add(points);
			}
		}
		
		await new Promise(resolve => {
			let arrQueries = [];
			db.takeConnectionFromPool(function (conn) {
				conn.addQuery(arrQueries, "BEGIN");
				conn.addQuery(arrQueries, "UPDATE user_addresses SET prevBalance = 0");
				rows1.forEach(row => {
					conn.addQuery(arrQueries, "UPDATE user_addresses SET prevBalance = ? WHERE address = ?", [row.balance, row.address]);
				});
				conn.addQuery(arrQueries, "COMMIT");
				async.series(arrQueries, () => {
					conn.release();
					resolve();
				});
			});
		});
		
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
		let refAddress = await getRefererFromAddress(winner_address);
		let winnerDeviceAddress = '';
		let refDeviceAddress = '';
		let rows2 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [winner_address]);
		winnerDeviceAddress = rows2[0].device_address;
		if (!refAddress) {
			refAddress = '-';
		} else {
			let rows3 = await db.query("SELECT device_address FROM user_addresses WHERE address = ?", [refAddress]);
			refDeviceAddress = rows3[0].device_address;
		}
		await db.query("INSERT INTO draws (bitcoin_hash, hash, winner_address, referrer_address, sum) values (?,?,?,?,?)",
			[value, hash, winner_address, refAddress, sum.toNumber()]);
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
			(referrer_address !== '-' ? 'referrer: ' + referrer_address + (refDeviceAddress === row.device_address ? ' (you)' : '') : '')
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
	mutex.lock(["pay_lock"], (unlock) => {
		db.query("SELECT * FROM draws WHERE bitcoin_hash = ?", [bitcoin_hash], rows => {
			if (rows.length) {
				async.each([1, 2, 3], (n, cb) => {
					if (n === 1) {
						if (rows[0].paid_bytes === 0) {
							payBytes(rows[0], (err, unit) => {
								if (!err) {
									db.query("UPDATE draws SET paid_bytes = 1, paid_bytes_unit = ? WHERE bitcoin_hash = ?", [unit, bitcoin_hash], cb);
								} else {
									cb();
								}
							});
						} else {
							cb();
						}
					}
					if (n === 2) {
						if (rows[0].paid_winner_bb === 0) {
							payBBWinner(rows[0], (err, unit) => {
								if (!err) {
									db.query("UPDATE draws SET paid_winner_bb = 1, paid_winner_address_bb_unit = ? WHERE bitcoin_hash = ?",
										[unit, bitcoin_hash], cb);
								} else {
									cb();
								}
							})
						}
					}
					if (n === 3) {
						if (rows[0].paid_referrer_bb === 0) {
							payBBReferrer(rows[0], (err, unit) => {
								if (!err) {
									db.query("UPDATE draws SET paid_referrer_bb = 1, paid_referrer_bb_unit = ? WHERE bitcoin_hash = ?",
										[unit, bitcoin_hash], cb);
								} else {
									cb();
								}
							});
						}
					}
				}, unlock);
			}
		});
	});
}

function payBytes(row, cb) {
	let outputs = [{address: row.winner_address, amount: conf.rewardForWinnerInBytes}];
	if (row.referrer_address !== '-') {
		outputs.push({address: row.referrer_address, amount: conf.rewardForReferrerInBytes});
	}
	headlessWallet.sendPaymentUsingOutputs('base', outputs, myAddress, (err, unit) => {
		console.log('Pay Bytes - ', row.bitcoin_hash, ' - - ', err, unit);
		cb(err, unit);
	});
}

function payBBWinner(row, cb) {
	headlessWallet.sendPaymentUsingOutputs(constants.BLACKBYTES_ASSET, [{
			address: row.winner_address,
			amount: conf.rewardForWinnerInBlackBytes
		}], myAddress,
		(err, unit) => {
			console.log('Pay BB Winner - ', row.bitcoin_hash, ' - - ', err, unit);
			cb(err, unit);
		});
}

function payBBReferrer(row, cb) {
	headlessWallet.sendPaymentUsingOutputs(constants.BLACKBYTES_ASSET, [{
			address: row.referrer_address,
			amount: conf.rewardForReffererInBlackBytes
		}], myAddress,
		(err, unit) => {
			console.log('Pay BB referrer - ', row.bitcoin_hash, ' - - ', err, unit);
			cb(err, unit);
		});
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
	
	conf.nextDate = moment(conf.drawDate, 'DD.MM.YYYY hh:mm').add(conf.intervalDrawings, 'days');
	json.nextDate = conf.nextDate;
	fs.writeFile(userConfFile, JSON.stringify(json, null, '\t'), 'utf8', (err) => {
		if (err)
			throw Error('failed to write conf.json: ' + err);
	});
}

async function calcPoints(balance, address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ?", [address]);
	if (!rows.length) return {total: 0, greatNextCalc: 0, lessNextCalc: 0, change: 0};
	
	let amountForNextCalc = conf.amountForNextCalc * conf.unitValue;
	let greatNextCalc = new BigNumber(0);
	let lessNextCalc = new BigNumber(0);
	let change = new BigNumber(0);
	if (rows[0].attested) {
		if (balance > amountForNextCalc) {
			balance = new BigNumber(amountForNextCalc).add(new BigNumber(balance - amountForNextCalc).times(conf.multiplierMoreAmountNextCalc));
			greatNextCalc = new BigNumber(balance - amountForNextCalc).times(conf.multiplierMoreAmountNextCalc).div(conf.unitValue);
			lessNextCalc = new BigNumber(amountForNextCalc).div(conf.unitValue);
		} else {
			lessNextCalc = new BigNumber(balance).div(conf.unitValue);
		}
	} else {
		lessNextCalc = new BigNumber(balance).times(conf.multiplierNonAttested).div(conf.unitValue);
		balance = new BigNumber(balance).times(conf.multiplierNonAttested);
	}
	let total = new BigNumber(balance).div(conf.unitValue);
	if (balance > rows[0].prevBalance) {
		let _change = (new BigNumber(balance).minus(rows[0].prevBalance)).times(conf.multiplierForIncreasingBalance).div(conf.unitValue);
		total = total.add(_change);
		change = _change;
	} else if (balance < rows[0].prevBalance) {
		let _change = ((new BigNumber(balance).minus(rows[0].prevBalance)).abs()).times(conf.multiplierForDecreaseBalance).div(conf.unitValue);
		total = total.minus(_change);
		change = _change.times(-1);
	}
	return {total: total, greatNextCalc, lessNextCalc, change};
}

async function getRefererFromAddress(address) {
	let rows = await db.query("SELECT referrerRefCode, attested FROM user_addresses JOIN users USING(device_address) WHERE address = ?", [address]);
	if (!rows.length || (rows.length && rows[0].attested === 0)) {
		return null;
	} else {
		if (rows[0].referrerRefCode === '' || rows[0].referrerRefCode === '-') return null;
		let rows2 = await db.query("SELECT address FROM users JOIN user_addresses USING(device_address) WHERE refCode = ? AND attested = 1",
			[rows[0].referrerRefCode]);
		return rows2[0].address;
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
	let objAddresses = await getObjAddresses();
	if (rows.length) {
		objAddresses.nonDraws = false;
		objAddresses.winner_address = rows[0].winner_address;
		objAddresses.referrer_address = rows[0].referrer_address;
		objAddresses.lastSum = rows[0].sum;
	} else {
		objAddresses.nonDraws = true;
	}
	await ctx.render('index', objAddresses);
});

async function getObjAddresses() {
	let sum = new BigNumber(0);
	let rows = await db.query("SELECT address, attested, referrerRefCode FROM user_addresses JOIN users USING(device_address) WHERE signed = 1");
	let objAddresses = {};
	let addresses = [];
	rows.forEach(row => {
		addresses.push(row.address);
		objAddresses[row.address] = {attested: row.attested, points: "0", referrerRefCode: row.referrerRefCode};
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

async function existsAddress(address) {
	let rows = await db.query("SELECT * FROM user_addresses WHERE address = ?", [address]);
	return !!rows.length;
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
