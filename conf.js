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

// emails
exports.admin_email = '';
exports.from_email = '';


exports.unitValue = 1000000000;

exports.oracle = 'FOPUBEUPBC6YLIQDLKL6EW775BMV7YOH';

exports.drawDate = '19.11.2018 13:38';
exports.drawInterval = 7; // days

exports.site = 'https://draw.byteball.org';

exports.rewardForWinnerInBytes = 10;
exports.rewardForReferrerInBytes = 5;
exports.rewardForWinnerInBlackbytes = 50;
exports.rewardForReferrerInBlackbytes = 50;

exports.payoutCheckInterval = 60000 * 10;

exports.balanceThreshold = 10; // in GB
exports.multiplierForAmountAboveThreshold = 0.1;
exports.multiplierForNonAttested = 0.1;
exports.multiplierForBalanceIncrease = 0.1;
exports.multiplierForBalanceDecrease = 0.2;

exports.arrRealNameAttestors = ['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'];


