<?php

declare(strict_types=1);

/** Atomic JSON file read/write (write to temp file, then rename). */
final class JsonStore
{
    public static function read(string $path): mixed
    {
        if (!is_file($path)) {
            return null;
        }
        $contents = file_get_contents($path);
        if ($contents === false || $contents === '') {
            return null;
        }
        $data = json_decode($contents, true);
        return json_last_error() === JSON_ERROR_NONE ? $data : null;
    }

    public static function write(string $path, mixed $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Cannot create data directory: {$dir}");
        }

        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException('Failed to encode JSON: ' . json_last_error_msg());
        }

        $tmpPath = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (file_put_contents($tmpPath, $json) === false) {
            throw new RuntimeException("Failed to write temp file: {$tmpPath}");
        }
        if (!rename($tmpPath, $path)) {
            @unlink($tmpPath);
            throw new RuntimeException("Failed to move temp file into place: {$path}");
        }
        @chmod($path, 0664);
    }
}
