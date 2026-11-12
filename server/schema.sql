-- Gotthard Traffic Live – database schema
-- Readable reference. The deploy ships this file to cron/schema.sql (denied over
-- HTTP), never to the public web root. To initialise by hand:
--   mysql -u USER -p DATABASE < cron/schema.sql
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

-- Column additions for older installs are applied automatically and idempotently
-- by cron/migrate.php (run at the end of every deploy). When adding a column,
-- add it above AND to the $columns list in server/cron/migrate.php.
