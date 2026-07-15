-- Gotthard Traffic Live – database schema
-- Run once to initialise: mysql -u USER -p DATABASE < schema.sql
-- Compatible with MySQL 5.7+ and MariaDB 10.3+.

CREATE TABLE IF NOT EXISTS gotthard_snapshots (
    id             BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    fetched_at     DATETIME          NOT NULL COMMENT 'UTC timestamp of the fetch',
    tunnel_status  VARCHAR(20)       NOT NULL DEFAULT 'unknown',
    north_queue_km DECIMAL(5,2)      DEFAULT NULL,
    north_wait_min SMALLINT UNSIGNED DEFAULT NULL,
    north_cause    VARCHAR(200)      DEFAULT NULL,
    south_queue_km DECIMAL(5,2)      DEFAULT NULL,
    south_wait_min SMALLINT UNSIGNED DEFAULT NULL,
    south_cause    VARCHAR(200)      DEFAULT NULL,
    pass_status    VARCHAR(20)       NOT NULL DEFAULT 'unknown',
    pass_note      TEXT              DEFAULT NULL,
    planned_closures TEXT            DEFAULT NULL COMMENT 'JSON array of upcoming tunnel closures [{from,to,cause}]',
    PRIMARY KEY (id),
    INDEX idx_fetched_at (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration for installs created before planned_closures existed (safe, nullable):
-- ALTER TABLE gotthard_snapshots ADD COLUMN planned_closures TEXT DEFAULT NULL AFTER pass_note;
