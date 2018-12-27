CREATE TABLE IF NOT EXISTS users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	step CHAR(15) NOT NULL DEFAULT 'start',
	code CHAR(10) NOT NULL UNIQUE,
	referrerCode CHAR(10) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
-- query separator
CREATE INDEX IF NOT EXISTS byRefCode ON users(referrerCode);
-- query separator
CREATE TABLE IF NOT EXISTS user_addresses (
	device_address CHAR(33) NOT NULL,
	address CHAR(32) NOT NULL,
	attested TINYINT NOT NULL DEFAULT 0,
	excluded TINYINT NOT NULL DEFAULT 0,
	attested_user_id CHAR(44) NULL UNIQUE,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(address),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
-- query separator
CREATE INDEX IF NOT EXISTS byDeviceAddresses ON user_addresses(device_address);
-- query separator
CREATE TABLE IF NOT EXISTS draws (
	draw_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	bitcoin_hash CHAR(64) NOT NULL UNIQUE,
	winner_address CHAR(32) NOT NULL,
	referrer_address CHAR(32) NULL,
	balance_winner_address CHAR(32) NULL,
	balance_referrer_address CHAR(32) NULL,
	paid_bytes TINYINT NOT NULL DEFAULT 0,
	paid_winner_bb TINYINT NOT NULL DEFAULT 0,
	paid_referrer_bb INT NOT NULL DEFAULT 0,
	paid_balance_winner_bb TINYINT NOT NULL DEFAULT 0,
	paid_balance_referrer_bb TINYINT NOT NULL DEFAULT 0,
	paid_bytes_unit CHAR(44) NULL,
	paid_winner_bb_unit CHAR(44) NULL,
	paid_referrer_bb_unit CHAR(44) NULL,
	paid_balance_winner_bb_unit CHAR(44) NULL,
	paid_balance_referrer_bb_unit CHAR(44) NULL,
	sum DECIMAL(16,9) NOT NULL DEFAULT 0,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (winner_address) REFERENCES user_addresses(address),
	FOREIGN KEY (referrer_address) REFERENCES user_addresses(address)
);
-- query separator
CREATE TABLE IF NOT EXISTS prev_balances (
	draw_id INT NOT NULL,
	address CHAR(32) NOT NULL,
	balance INT NOT NULL,
	points CHAR(64) NULL,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(draw_id, address),
	FOREIGN KEY (address) REFERENCES user_addresses(address),
	FOREIGN KEY (draw_id) REFERENCES draws(draw_id)
);

/*
ALTER TABLE user_addresses ADD COLUMN excluded TINYINT NOT NULL DEFAULT 0;
ALTER TABLE user_addresses ADD COLUMN attested_user_id CHAR(44) NULL;
CREATE UNIQUE INDEX byAttUserId ON user_addresses(attested_user_id);
UPDATE user_addresses SET attested_user_id=(SELECT value FROM attested_fields WHERE attestor_address='I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT' AND attested_fields.address=user_addresses.address AND field='user_id') WHERE attested=1;
ALTER TABLE prev_balances ADD COLUMN points CHAR(64) NULL;

ALTER TABLE draws ADD COLUMN balance_winner_address CHAR(32) NULL;
ALTER TABLE draws ADD COLUMN balance_referrer_address CHAR(32) NULL;
ALTER TABLE draws ADD COLUMN paid_balance_winner_bb TINYINT NOT NULL DEFAULT 0;
ALTER TABLE draws ADD COLUMN paid_balance_referrer_bb TINYINT NOT NULL DEFAULT 0;
ALTER TABLE draws ADD COLUMN paid_balance_winner_bb_unit CHAR(44) NULL;
ALTER TABLE draws ADD COLUMN paid_balance_referrer_bb_unit CHAR(44) NULL;
*/
