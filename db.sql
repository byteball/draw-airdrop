CREATE TABLE users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	step CHAR(15) NOT NULL DEFAULT 'start',
	code CHAR(10) NULL UNIQUE,
	referrerCode CHAR(10) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
CREATE INDEX byRefCode ON users(referrerCode);

CREATE TABLE user_addresses (
	device_address CHAR(33) NOT NULL,
	address CHAR(32) NOT NULL,
	signed TINYINT NOT NULL DEFAULT 0,
	attested TINYINT NOT NULL DEFAULT 0,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(address),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
CREATE INDEX byDeviceAddresses ON user_addresses(device_address);

CREATE TABLE draws (
	draw_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	bitcoin_hash CHAR(64) NOT NULL UNIQUE,
	winner_address CHAR(32) NOT NULL,
	referrer_address CHAR(32) NULL,
	paid_bytes TINYINT NOT NULL DEFAULT 0,
	paid_winner_bb TINYINT NOT NULL DEFAULT 0,
	paid_referrer_bb INT NOT NULL DEFAULT 0,
	paid_bytes_unit CHAR(44) NULL,
	paid_winner_bb_unit CHAR(44) NULL,
	paid_referrer_bb_unit CHAR(44) NULL,
	sum INT NOT NULL DEFAULT 0,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (winner_address) REFERENCES user_addresses(address),
	FOREIGN KEY (referrer_address) REFERENCES user_addresses(address)
);

CREATE TABLE prev_balances (
	draw_id INT NOT NULL,
	address CHAR(32) NOT NULL,
	balance INT NOT NULL,
	date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY(draw_id, address),
	FOREIGN KEY (address) REFERENCES user_addresses(address),
	FOREIGN KEY (draw_id) REFERENCES draws(draw_id)
);