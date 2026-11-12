<?php

declare(strict_types=1);

/**
 * Idempotent database migration. CLI only; run at the end of every deploy:
 *
 *   php cron/migrate.php
 *
 * 1. Creates missing tables from schema.sql (CREATE TABLE IF NOT EXISTS).
 * 2. Applies additive column migrations, each guarded by an
 *    information_schema.COLUMNS check so re-running is always safe.
 *
 * schema.sql stays the readable reference; add every new column both there
 * and to $columns below.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}

require_once __DIR__ . '/../lib/Db.php';

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing config.php.\n");
    exit(1);
}

/** table => [column => column definition used in ALTER TABLE ... ADD COLUMN] */
$columns = [
    'gotthard_snapshots' => [
        'closure_reason'   => "closure_reason VARCHAR(200) DEFAULT NULL COMMENT 'Ursache of an active full tunnel closure' AFTER tunnel_status",
        'planned_closures' => "planned_closures TEXT DEFAULT NULL COMMENT 'JSON array of upcoming tunnel closures' AFTER pass_note",
        'pass_source'      => "pass_source VARCHAR(30) DEFAULT NULL COMMENT 'datex or alpen-paesse.ch' AFTER pass_note",
    ],
];

try {
    /** @var array $config */
    $config = require $configPath;
    $pdo    = Db::connect($config);

    $schemaPath = __DIR__ . '/schema.sql';
    if (!is_file($schemaPath)) {
        $schemaPath = __DIR__ . '/../schema.sql'; // repo layout
    }
    $sql = (string) file_get_contents($schemaPath);
    $sql = preg_replace('/^\s*--.*$/m', '', $sql) ?? $sql;
    foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
        $pdo->exec($statement);
    }
    echo "schema: tables ensured\n";

    $check = $pdo->prepare(
        'SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
    );
    foreach ($columns as $table => $defs) {
        foreach ($defs as $column => $definition) {
            $check->execute([$table, $column]);
            if ((int) $check->fetchColumn() === 0) {
                $pdo->exec("ALTER TABLE `{$table}` ADD COLUMN {$definition}");
                echo "added {$table}.{$column}\n";
            }
        }
    }
    echo "migrations: up to date\n";
} catch (Throwable $e) {
    fwrite(STDERR, 'migrate failed: ' . $e->getMessage() . "\n");
    exit(1);
}
