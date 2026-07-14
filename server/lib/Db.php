<?php

declare(strict_types=1);

/** PDO singleton — call Db::connect($config) to get the shared connection. */
final class Db
{
    private static ?PDO $pdo = null;

    public static function connect(array $config): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $host = $config['db_host'] ?? 'localhost';
        $name = $config['db_name'] ?? throw new RuntimeException('db_name not set in config.');
        $user = $config['db_user'] ?? throw new RuntimeException('db_user not set in config.');
        $pass = $config['db_pass'] ?? throw new RuntimeException('db_pass not set in config.');
        $port = isset($config['db_port']) ? ';port=' . (int) $config['db_port'] : '';

        $dsn = "mysql:host={$host}{$port};dbname={$name};charset=utf8mb4";

        self::$pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);

        return self::$pdo;
    }
}
