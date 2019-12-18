/*jslint node: true */
"use strict";
var async = require('async');
var db = require('ocore/db.js');
var eventBus = require('ocore/event_bus.js');
var headlessWallet = require('headless-obyte');

//const announcement = "Byteball 2.0 released, it allows to send Bytes to email address, even if the recipient is not in Byteball yet.\n\nLearn more: https://medium.com/byteball/sending-cryptocurrency-to-email-5c9bce22b8a9";
//const announcement = "We are extremely pleased to announce our first decentralized witness candidate. This is a major milestone for Byteball. Read the full article here: https://medium.com/byteball/first-decentralized-witness-candidate-rogier-eijkelhof-9e5619166334";
//const announcement = "Obyte needs your help to get decentralized. The second independent witness candidate Fabien Marino was put forward 2 months ago https://medium.com/obyte/second-independent-witness-candidate-fabien-marino-d4e8dccadee but we have not had enough community feedback so far. The Obyte Foundation will not decide everything for you, please take part in Obyte governance and either support Fabien by editing the witness list in your wallet as indicated in the article or air your concerns on Obyte Discord, Reddit, or Telegram. Don’t stay indifferent, the faster we decentralize, the more likely we will be able to attract well known real world brands to the project! Suggestions of other witness candidates are also welcome.";
const announcement = "Bosch is the next witness candidate https://medium.com/obyte/bosch-connectory-is-the-next-candidate-to-become-a-witness-on-the-obyte-public-network-b99572870644\n\nPlease vote for or against them before December 27.";
const optout_text = "\n\nIf you don't want to receive news here, [click here to opt out](command:optout).";
const message = announcement + optout_text;

headlessWallet.setupChatEventHandlers();

function sendAnnouncement(){
	var device = require('ocore/device.js');
	db.query(
		"SELECT correspondent_devices.device_address \n\
		FROM correspondent_devices \n\
		LEFT JOIN optouts USING(device_address) \n\
	--	LEFT JOIN recipients ON states.device_address=recipients.device_address \n\
		WHERE optouts.device_address IS NULL \n\
			-- AND recipients.device_address IS NULL \n\
			/* AND states.device_address='0DCR73VWY5K5QU7R43T3VJN34FWEWF6VN' */",
		rows => {
			console.error(rows.length+" messages will be sent");
			async.eachSeries(
				rows,
				(row, cb) => {
					device.sendMessageToDevice(row.device_address, 'text', message, {
						ifOk: function(){}, 
						ifError: function(){}, 
						onSaved: function(){
							return cb();
						/*	db.query("INSERT "+db.getIgnore()+" INTO recipients (device_address) VALUES (?)", [row.device_address], () => {
								if (Date.now() % 100 === 0)
									console.error(row.device_address);
								cb();
							});*/
						}
					});
				},
				() => {
					console.error("=== done");
				}
			);
		}
	);
}

eventBus.on('text', function(from_address, text){
	var device = require('ocore/device.js');
	console.log('text from '+from_address+': '+text);
	text = text.trim().toLowerCase();
	if (text === 'optout'){
		db.query("INSERT "+db.getIgnore()+" INTO optouts (device_address) VALUES(?)", [from_address]);
		return device.sendMessageToDevice(from_address, 'text', 'You are unsubscribed from future announcements.');
	}
	else if (text.match(/thank/))
		device.sendMessageToDevice(from_address, 'text', "You're welcome!");
	else
		device.sendMessageToDevice(from_address, 'text', "Address linking is paused while sending announcements.  Check again in a few minutes.");
});

eventBus.on('headless_wallet_ready', () => {
	setTimeout(sendAnnouncement, 1000);
});

