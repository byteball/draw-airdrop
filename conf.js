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
exports.deviceName = 'Bot example';
exports.permanent_pairing_secret = '*'; // * allows to pair with any code, the code is passed as 2nd param to the pairing event handler
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.bIgnoreUnpairRequests = true;
exports.bSingleAddress = false;
exports.bStaticChangeAddress = true;
exports.KEYS_FILENAME = 'keys.json';

// emails
exports.admin_email = '';
exports.from_email = '';


exports.unitValue = 1000000000;

exports.oracle = 'FOPUBEUPBC6YLIQDLKL6EW775BMV7YOH';

exports.drawDate = '19.11.2018 13:38';
exports.drawInterval = 7; // days

exports.rewardForWinnerInBytes = 10;
exports.rewardForReferrerInBytes = 5;
exports.rewardForWinnerInBlackBytes = 50;
exports.rewardForReffererInBlackBytes = 50;

exports.amountForNextCalc = 10;

exports.payoutCheckInterval = 60000 * 10;

exports.multiplierMoreAmountNextCalc = 0.1;
exports.multiplierNonAttested = 0.1;
exports.multiplierForIncreasingBalance = 0.1;
exports.multiplierForDecreaseBalance = 0.1;

exports.arrRealNameAttestors = ['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'];


