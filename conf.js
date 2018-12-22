/*jslint node: true */
"use strict";
exports.port = null;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;

exports.storage = 'sqlite';

// TOR is recommended. Uncomment the next two lines to enable it
//exports.socksHost = '127.0.0.1';
//exports.socksPort = 9050;

exports.hub = 'byteball.org/bb';
exports.deviceName = 'Draw Airdrop';
exports.permanent_pairing_secret = '*'; // * allows to pair with any code, the code is passed as 2nd param to the pairing event handler
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.bIgnoreUnpairRequests = true;
exports.bSingleAddress = true;
exports.bStaticChangeAddress = true;
exports.KEYS_FILENAME = 'keys.json';

// smtp https://github.com/byteball/byteballcore/blob/master/mail.js
exports.smtpTransport = 'local'; // use 'local' for Unix Sendmail
exports.smtpRelay = '';
exports.smtpUser = '';
exports.smtpPassword = '';
exports.smtpSsl = null;
exports.smtpPort = null;

// emails
exports.admin_email = '';
exports.from_email = '';


exports.unitValue = 1000000000;

exports.oracle = 'FOPUBEUPBC6YLIQDLKL6EW775BMV7YOH';

exports.drawDate = '14.12.2018 12:00';
exports.drawInterval = 7; // days

exports.site = 'http://draw.byteball.org';

exports.rewardForWinnerInBytes = 200e9;
exports.rewardForReferrerInBytes = exports.rewardForWinnerInBytes/2;
exports.rewardForWinnerInBlackbytes = exports.rewardForWinnerInBytes * 2.1111;
exports.rewardForReferrerInBlackbytes = exports.rewardForReferrerInBytes * 2.1111;

exports.payoutCheckInterval = 60000 * 10;

exports.balanceThreshold1 = 10; // in GB
exports.balanceThreshold2 = 100; // in GB
exports.multiplierForAmountAboveThreshold1 = 0.1;
exports.multiplierForAmountAboveThreshold2 = 0.01;
exports.multiplierForNonAttested = 0.01;
exports.multiplierForBalanceIncrease = 0.1;
exports.multiplierForBalanceDecrease = 0.2;
exports.maxBalanceIncreaseFactor = 2;

exports.arrRealNameAttestors = ['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'];
exports.arrSteemAttestors = ['JEDZYC2HMGDBIDQKG3XSTXUSHMCBK725'];
exports.minSteemReputation = 60;

exports.webPort = 3000;