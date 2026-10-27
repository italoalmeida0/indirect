import { Show } from "solid-js";
import { AnalyticsToolbar, createAnalyticsFilters } from "../../analytics-filters";
import { createAnalyticsReport } from "../../analytics-report";
import { AnalyticsSummary } from "../../AnalyticsSummary";
import { AnalyticsError, AnalyticsLoading, AnalyticsSection, ApiKeyUsageCard, CacheUsageChart, ModelUsageChart, RequestOutcomesChart, ProviderMixChart, UserEfficiencyChart, UserSpendChart } from "../../AnalyticsCharts";
import { PageTitle } from "../../index";
import { Icon, fmtNum } from "../../ui";

export default function StatsPage() {
  const filters = createAnalyticsFilters(true);
  const { report, refetch } = createAnalyticsReport(filters, true);
  const selectUser = (id: string, label: string) => filters.toggle("user_id", "include", id, label);
  const selectModel = (id: string, label: string) => filters.toggle("model", "include", id, label);

  return <div class="analytics-page global-stats-page" aria-busy={filters.pending() || report.loading}>
    <div class="overview-header">
      <PageTitle title="Global Stats" subtitle="A clear view of spend, traffic and the people behind it" />
      <AnalyticsToolbar filters={filters} loading={report.loading} align="end" />
    </div>
    <Show when={!report.error} fallback={<AnalyticsError retry={refetch} />}>
      <Show when={report()} fallback={<AnalyticsLoading />} keyed>{(data) => <>
        <AnalyticsSummary report={data} label={data.label} query={data.query} section="costs" />
        <div class="analytics-scope-context">
          <span><Icon name="lucide:users" size={14} /><strong>{fmtNum(data.activeUsers)}</strong> users with activity</span>
          <span><Icon name="lucide:network" size={14} /><strong>{fmtNum(data.providers.reduce((sum, provider) => sum + provider.members, 0))}</strong> providers with traffic</span>
          <span><Icon name="lucide:list-filter" size={14} />Every chart follows the selected scope</span>
        </div>
        <AnalyticsSection title="Where spend goes" description="Compare model adoption and understand the cost of your selected traffic." />
        <ModelUsageChart modelColors={data.modelColors} data={data.modelSpend} metric="cost" period={data.label} onSelect={selectModel} />
        <AnalyticsSection title="People & routing" description="Select a user or provider to focus the entire dashboard. Use the filter chips to broaden the view again." />
        <div class="analytics-detail-grid analytics-audience-grid">
          <UserSpendChart users={data.users} period={data.label} onSelect={selectUser} />
          <ProviderMixChart providers={data.providers} protocols={data.protocols} period={data.label} onSelect={(field, id, label) => filters.toggle(field, "include", id, label)} />
        </div>
        <div class="analytics-detail-grid">
          <UserEfficiencyChart users={data.users} period={data.label} onSelect={selectUser} />
          <CacheUsageChart series={data.series} period={data.label} />
        </div>
        <AnalyticsSection title="Requests & reliability" description="Follow traffic and response outcomes, then select an API key to inspect its activity." />
        <AnalyticsSummary report={data} label={data.label} query={data.query} section="requests" />
        <div class="analytics-detail-grid">
          <ModelUsageChart modelColors={data.modelColors} data={data.modelRequests} metric="reqs" period={data.label} onSelect={selectModel} />
          <RequestOutcomesChart outcomes={data.outcomes} period={data.label} />
        </div>
        <ApiKeyUsageCard keys={data.keys} period={data.label} onSelect={(id, label) => filters.toggle("key_id", "include", id, label)} />
      </>}</Show>
    </Show>
  </div>;
}
