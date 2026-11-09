-- Gotthard Traffic Live – database schema
-- Run once to initialise: mysql -u USER -p DATABASE < schema.sql
-- Compatible with MySQL 5.7+ and MariaDB 10.3+.

CREATE TABLE IF NOT EXISTS gotthard_snapshots (
    id             BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    fetched_at     DATETIME          NOT NULL COMMENT 'UTC timestamp of the fetch',
    tunnel_status  VARCHAR(20)       NOT NULL DEFAULT 'unknown',
    closure_reason VARCHAR(200)      DEFAULT NULL COMMENT 'Ursache of an active full tunnel closure, e.g. Pannenfahrzeug',
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

-- Hourly weather at the two portals (Open-Meteo), for correlating jams with
-- temperature / rain / snow. One row per UTC hour and portal.
-- Existing installs: just run this CREATE TABLE (it is idempotent).
CREATE TABLE IF NOT EXISTS gotthard_weather (
    id               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    observed_at      DATETIME         NOT NULL COMMENT 'UTC, top of the hour',
    portal           VARCHAR(5)       NOT NULL COMMENT 'north (Göschenen) or south (Airolo)',
    temperature_c    DECIMAL(4,1)     DEFAULT NULL,
    precipitation_mm DECIMAL(5,2)     DEFAULT NULL,
    snowfall_cm      DECIMAL(5,2)     DEFAULT NULL,
    weather_code     SMALLINT         DEFAULT NULL COMMENT 'WMO weather code',
    PRIMARY KEY (id),
    UNIQUE KEY uq_observed_portal (observed_at, portal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration for installs created before planned_closures existed (safe, nullable):
-- ALTER TABLE gotthard_snapshots ADD COLUMN planned_closures TEXT DEFAULT NULL AFTER pass_note;

-- Migration for installs created before closure_reason existed (safe, nullable):
-- ALTER TABLE gotthard_snapshots ADD COLUMN closure_reason VARCHAR(200) DEFAULT NULL AFTER tunnel_status;
