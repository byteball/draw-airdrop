CREATE TABLE users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    step CHAR(15) NOT NULL DEFAULT 'start',
	refId CHAR(10) NULL,
	invitedRefId CHAR(10) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

CREATE TABLE user_addresses (
    device_address CHAR(33) NOT NULL,
    address CHAR(32) NOT NULL,
    signed INT NOT NULL DEFAULT 0,
    attested INT NOT NULL DEFAULT 0,
    balance INT NOT NULL DEFAULT 0,
    date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(device_address, address),
    FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
CREATE INDEX byUserAddresses ON user_addresses(address);

CREATE TABLE draws (
    bitcoin_hash CHAR(64) NOT NULL,
    hash CHAR(64) NOT NULL,
    winner_address CHAR(32) NOT NULL,
    referrer_address CHAR(32) NOT NULL,
    paid_bytes INT NOT NULL DEFAULT 0,
    paid_winner_bb INT NOT NULL DEFAULT 0,
    paid_referrer_bb INT NOT NULL DEFAULT 0,
    paid_bytes_unit CHAR(44) NULL,
    paid_winner_bb_unit CHAR(44) NULL,
    paid_referrer_bb_unit CHAR(44) NULL,
    sum INT NOT NULL DEFAULT 0,
    date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(bitcoin_hash)
);