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

exports.nextReward = '19.11.2018 13:38';
exports.intervalReward = 7; // days

exports.rewardB = 10;
exports.refRewardB = 5;
exports.rewardBB = 50;
exports.refRewardBB = 50;

exports.amountForNextCalc = 10;

exports.rePaidInterval = 60000 * 10;

exports.arrRealNameAttestors = ['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'];


