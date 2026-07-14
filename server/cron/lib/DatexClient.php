<?php

declare(strict_types=1);

final class DatexFetchException extends RuntimeException
{
}

/**
 * Thin HTTP client for the opentransportdata.swiss / ASTRA DATEX II
 * "TrafficSituations" pull endpoint. Returns the raw XML body; parsing is
 * handled separately in TrafficParser so this class stays easy to unit-test.
 */
final class DatexClient
{
    public function __construct(private readonly array $config)
    {
    }

    /**
     * @return string raw XML response body
     * @throws DatexFetchException
     */
    // Default SOAP action for the FEDRO/ASTRA Traffic Situations pull service.
    private const DEFAULT_SOAP_ACTION = 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages';

    public function fetchRaw(): string
    {
        $url = $this->config['api_url'];

        $token = $this->config['api_token'] ?? '';
        if ($token === '' || $token === 'YOUR_API_TOKEN_HERE') {
            throw new DatexFetchException('No API token configured (see config.example.php).');
        }

        // The endpoint is a SOAP 1.1 service: it requires a POST with a SOAPAction
        // header and a SOAP envelope body. A bare GET returns HTTP 404.
        $headerName  = $this->config['auth_header'] ?? 'Authorization';
        $prefix      = $this->config['auth_prefix'] ?? 'Bearer ';
        $soapAction  = $this->config['soap_action'] ?? self::DEFAULT_SOAP_ACTION;
        $contentType = $this->config['content_type'] ?? 'application/soap+xml';

        $headers = [
            "{$headerName}: {$prefix}{$token}",
            "SOAPAction: {$soapAction}",
            "Content-Type: {$contentType}; charset=utf-8",
            'Accept: application/xml, text/xml, application/soap+xml',
        ];

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $this->buildRequestEnvelope(),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_USERAGENT => 'gotthard-traffic-scraper/1.0 (+https://github.com/)',
        ]);

        $body = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($errno !== 0) {
            throw new DatexFetchException("cURL error ({$errno}): {$error}");
        }
        if ($status < 200 || $status >= 300) {
            $snippet = substr((string) $body, 0, 300);
            throw new DatexFetchException("Unexpected HTTP status {$status}. Body starts with: {$snippet}");
        }
        if ($body === false || trim((string) $body) === '') {
            throw new DatexFetchException('Empty response body.');
        }

        return $body;
    }

    /**
     * SOAP 1.1 envelope requesting a full pull of current traffic messages.
     * Mirrors the sample in the opentransportdata.swiss road-traffic cookbook.
     */
    private function buildRequestEnvelope(): string
    {
        $start = (new DateTimeImmutable('-1 day'))->format('Y-m-d\TH:i:s.00P');

        return <<<XML
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <d2LogicalModel xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0">
      <exchange>
        <supplierIdentification>
          <country>ch</country>
          <nationalIdentifier>FEDRO</nationalIdentifier>
        </supplierIdentification>
        <subscription>
          <operatingMode>operatingMode1</operatingMode>
          <subscriptionStartTime>{$start}</subscriptionStartTime>
          <subscriptionState>active</subscriptionState>
          <updateMethod>singleElementUpdate</updateMethod>
          <target>
            <address></address>
            <protocol>http</protocol>
          </target>
        </subscription>
      </exchange>
    </d2LogicalModel>
  </soap:Body>
</soap:Envelope>
XML;
    }
}
