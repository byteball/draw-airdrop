CREATE TABLE users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	myRefId CHAR(40) NULL,
	regRefId CHAR(40) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

CREATE TABLE users_addresses (
    device_address CHAR(33) NOT NULL,
    address CHAR(32) NOT NULL,
    signed INT NOT NULL DEFAULT 0,
    attested INT NOT NULL DEFAULT 0,
    balance INT NOT NULL DEFAULT 0,
    PRIMARY KEY(device_address, address),
    FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

CREATE TABLE lotteries (
    bitcoin_hash CHAR(64) NOT NULL,
    hash CHAR(64) NOT NULL,
    winner CHAR(32) NOT NULL,
    refer CHAR(32) NOT NULL,
    paid_bytes INT NOT NULL DEFAULT 0,
    paid_winner_bb INT NOT NULL DEFAULT 0,
    paid_refer_bb INT NOT NULL DEFAULT 0,
    paid_bytes_unit CHAR(44) NULL,
    paid_winner_bb_unit CHAR(44) NULL,
    paid_refer_bb_unit CHAR(44) NULL,
    PRIMARY KEY(bitcoin_hash)
);