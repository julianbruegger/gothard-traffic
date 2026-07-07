<?php

declare(strict_types=1);

final class I18n
{
    private static ?array $translations = null;

    private static function load(): array
    {
        if (self::$translations === null) {
            $path = __DIR__ . '/../translations.json';
            $json = is_file($path) ? file_get_contents($path) : '{}';
            self::$translations = json_decode((string) $json, true) ?? [];
        }
        return self::$translations;
    }

    public static function t(string $lang, string $key): string
    {
        $dict = self::load();
        return $dict[$lang][$key] ?? $dict['de'][$key] ?? $key;
    }

    public static function isSupported(?string $lang): bool
    {
        return $lang === 'de' || $lang === 'en';
    }
}
