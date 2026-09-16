/**
 * Cloudflare analytics client.
 * Production rule: no fabricated telemetry and no silent success fallback.
 */

export interface CloudflareTrafficMetrics {
  totalRequests: number;
  cachedRequests: number;
  cacheHitRatio: number;
  totalBandwidthBytes: number;
  cachedBandwidthBytes: number;
  uniqueVisitors: number;
  statusCodes: { code2xx: number; code3xx: number; code4xx: number; code5xx: number };
  timeseries: Array<{ timestamp: string; requests: number; cached: number; threats: number }>;
}

export interface CloudflareDnsMetrics {
  totalQueries: number;
  queryRatePerSec: number;
  avgLatencyMs: number;
  responseCodes: { noError: number; nxDomain: number; servFail: number; other: number };
  nameservers: Array<{ name: string; status: 'operational' | 'degraded' | 'unreachable'; pop: string; latencyMs: number }>;
}

export interface CloudflareSecurityMetrics {
  threatsBlocked: number;
  rateLimitActions: number;
  botScoreAvg: number;
  topThreats: Array<{ action: string; ruleId: string; sourceIp: string; country: string; count: number }>;
}

export interface CloudflareWorkersMetrics {
  invocations: number;
  cpuTimeMedianMs: number;
  durationAvgMs: number;
  errorCount: number;
  pagesDeployStatus: {
    project: string;
    lastDeploy: string;
    environment: 'production' | 'preview';
    status: 'success' | 'building' | 'failed';
    sslActive: boolean;
  };
}

export interface CloudflareAnalyticsSummary {
  zoneId?: string;
  zoneName: string;
  source: 'live' | 'simulation';
  lastUpdated: string;
  traffic: CloudflareTrafficMetrics;
  dns: CloudflareDnsMetrics;
  security: CloudflareSecurityMetrics;
  workers: CloudflareWorkersMetrics;
  limitations?: string[];
}

const EMPTY: CloudflareAnalyticsSummary = {
  zoneName: '',
  source: 'simulation',
  lastUpdated: '',
  traffic: {
    totalRequests: 0,
    cachedRequests: 0,
    cacheHitRatio: 0,
    totalBandwidthBytes: 0,
    cachedBandwidthBytes: 0,
    uniqueVisitors: 0,
    statusCodes: { code2xx: 0, code3xx: 0, code4xx: 0, code5xx: 0 },
    timeseries: [],
  },
  dns: { totalQueries: 0, queryRatePerSec: 0, avgLatencyMs: 0, responseCodes: { noError: 0, nxDomain: 0, servFail: 0, other: 0 }, nameservers: [] },
  security: { threatsBlocked: 0, rateLimitActions: 0, botScoreAvg: 0, topThreats: [] },
  workers: { invocations: 0, cpuTimeMedianMs: 0, durationAvgMs: 0, errorCount: 0, pagesDeployStatus: { project: '', lastDeploy: '', environment: 'production', status: 'failed', sslActive: false } },
};

export const MOCK_CLOUDFLARE_ANALYTICS = EMPTY;

export async function getCloudflareAnalytics(apiToken?: string, zoneId?: string): Promise<CloudflareAnalyticsSummary> {
  const token = apiToken?.trim() || (typeof window !== 'undefined' ? localStorage.getItem('cf_api_token') || '' : '');
  const zone = zoneId?.trim() || (typeof window !== 'undefined' ? localStorage.getItem('cf_zone_id') || '' : '');

  if (!token || !zone) {
    return { ...EMPTY, limitations: ['Cloudflare API token atau Zone ID belum dikonfigurasi.'] };
  }

  const query = `query GetZoneAnalytics($zoneTag: String!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        name
        httpRequests1dGroups(limit: 1, orderBy: [date_DESC]) {
          sum { requests cachedRequests bytes cachedBytes threats pageViews }
          uniq { uniques }
        }
      }
    }
  }`;

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { zoneTag: zone } }),
    });

    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Cloudflare GraphQL HTTP ${res.status}`);
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new Error(body.errors.map((e: any) => e?.message || 'GraphQL error').join('; '));
    }

    const zoneData = body?.data?.viewer?.zones?.[0];
    const group = zoneData?.httpRequests1dGroups?.[0];
    if (!zoneData || !group) throw new Error('Zone tidak ditemukan atau analytics tidak tersedia untuk token ini.');

    const sum = group.sum || {};
    const totalReq = Number(sum.requests || 0);
    const cachedReq = Number(sum.cachedRequests || 0);

    return {
      zoneId: zone,
      zoneName: zoneData.name || `Cloudflare Zone ${zone.slice(0, 8)}…`,
      source: 'live',
      lastUpdated: new Date().toISOString(),
      traffic: {
        totalRequests: totalReq,
        cachedRequests: cachedReq,
        cacheHitRatio: totalReq ? Number(((cachedReq / totalReq) * 100).toFixed(2)) : 0,
        totalBandwidthBytes: Number(sum.bytes || 0),
        cachedBandwidthBytes: Number(sum.cachedBytes || 0),
        uniqueVisitors: Number(group.uniq?.uniques || 0),
        statusCodes: { code2xx: 0, code3xx: 0, code4xx: 0, code5xx: 0 },
        timeseries: [],
      },
      dns: EMPTY.dns,
      security: { ...EMPTY.security, threatsBlocked: Number(sum.threats || 0) },
      workers: EMPTY.workers,
      limitations: [
        'Status-code timeseries, DNS, dan Workers tidak diklaim live karena query ini belum meminta sumber datanya.',
      ],
    };
  } catch (e: any) {
    throw new Error(e?.message || 'Cloudflare Live API gagal dihubungi.');
  }
}
