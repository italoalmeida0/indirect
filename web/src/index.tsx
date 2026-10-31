import "./fonts.css";

import { render } from "solid-js/web";
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  lazy,
  onCleanup,
  onMount,
  Show,
  For,
  Suspense,
  type JSX,
} from "solid-js";

import {
  currentSession,
  onSessionChange,
  setSession,
  api,
  type ApiKeyDto,
} from "./api";
import {
  Icon,
  Icons,
  Toasts,
  Tooltip,
  toast,
  watchSystemTheme,
} from "./ui";
import { setMotionEnabled } from "./motion";
import LoginPage from "./pages/Login";
import SetPasswordPage from "./pages/SetPassword";
import { PlanLimits } from "./billing";
/**
 * Route-level code splitting. The dashboard bundle is dominated by the
 * Indirect Code workspace (transcript rendering, generative UI runtimes) and
 * the AG Grid catalog screens, none of which a first visit to the overview
 * needs. Each route loads its own chunk on demand, so the first paint only
 * pays for the shell plus the current page.
 *
 * The login and set-password pages stay eager: they are the entry point for
 * an unauthenticated visitor and splitting them would only add a round trip.
 */
const DashboardPage = lazy(() => import("./pages/Dashboard"));
const IndirectCodePage = lazy(() => import("./indirect-code/IndirectCodePage"));
const CodeDevPage = lazy(() => import("./indirect-code/CodeDevPage"));
const KeysPage = lazy(() => import("./pages/Keys"));
const UsagePage = lazy(() => import("./pages/Usage"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const AdminProvidersPage = lazy(() => import("./pages/admin/Providers"));
const AdminModelsPage = lazy(() => import("./pages/admin/Models"));
const AdminPlansPage = lazy(() => import("./pages/admin/Plans"));
const AdminUsersPage = lazy(() => import("./pages/admin/Users"));
const AdminKeysPage = lazy(() => import("./pages/admin/Keys"));
const AdminStatsPage = lazy(() => import("./pages/admin/Stats"));
const AdminAuditPage = lazy(() => import("./pages/admin/Audit"));
const ProjectsPage = lazy(() => import("./pages/Projects"));
const OrganizationPage = lazy(() => import("./pages/admin/Organization"));

/**
 * Hash router. All app routes live under `#/…` so the static server never
 * has to think about deep links.
 */

const [route, setRoute] = createSignal(parseHash());

function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path || "/", query: new URLSearchParams(qs ?? "") };
}

export { navigate, LogoMark, PageTitle } from "./chrome";
import { navigate } from "./chrome";

window.addEventListener("hashchange", () => setRoute(parseHash()));

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const USER_NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: Icons.home },
  { path: "/code", label: "Indirect Code", icon: Icons.idc },
  { path: "/keys", label: "API Keys", icon: Icons.key },
  { path: "/usage", label: "Usage", icon: Icons.chart },
  { path: "/limits", label: "Plan & limits", icon: "lucide:wallet" },
  { path: "/projects", label: "Financial projects", icon: Icons.folder },
  { path: "/settings", label: "Settings", icon: Icons.cog },
];

const ADMIN_NAV: NavItem[] = [
  { path: "/admin", label: "Global stats", icon: Icons.bolt },
  { path: "/admin/providers", label: "Providers", icon: Icons.server },
  { path: "/admin/models", label: "Models", icon: Icons.layers },
  { path: "/admin/users", label: "Users", icon: Icons.users },
  { path: "/admin/plans", label: "Plans", icon: "lucide:wallet" },
  { path: "/admin/keys", label: "All Keys", icon: Icons.key },
  { path: "/admin/audit", label: "Audit Log", icon: Icons.book },
  { path: "/admin/organization", label: "Organization", icon: Icons.cog },
];

function pageInfo(path: string): NavItem {
  const all = [...USER_NAV, ...ADMIN_NAV];
  return (
    all.find((i) =>
      i.path === "/" || i.path === "/admin"
        ? path === i.path || (i.path === "/admin" && path === "/admin/stats")
        : path.startsWith(i.path),
    ) ?? USER_NAV[0]!
  );
}

/** Placeholder while a route chunk downloads. Deliberately minimal: it is
 *  visible for one round trip on a cold cache, never on a warm one. */
function RouteChunk(props: { children: JSX.Element }): JSX.Element {
  return (
    <Suspense
      fallback={
        <div class="route-loading" role="status" aria-live="polite" aria-busy="true">
          <span class="route-loading-dot" />
          <span class="route-loading-dot" />
          <span class="route-loading-dot" />
          <span class="sr-only">Loading</span>
        </div>
      }
    >
      {props.children}
    </Suspense>
  );
}

function isActive(item: NavItem, current: string): boolean {
  return item.path === "/"
    ? current === "/"
    : item.path === "/admin"
      ? current === "/admin" || current === "/admin/stats"
      : current.startsWith(item.path);
}

/** Icon-rail button with hover tooltip (desktop rail). */
function RailItem(props: { item: NavItem; current: string; badge?: number }) {
  const active = () => isActive(props.item, props.current);
  return (
      <a
        href={`#${props.item.path}`}
        class={`gateway-nav relative flex h-9 w-9 lg:w-60 items-center justify-center lg:justify-start lg:px-2.5 gap-2.5 rounded-lg transition-colors duration-150 ${
          active()
            ? "text-ink-100"
            : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/60"
        }`}
        aria-label={props.item.label}
        aria-current={active() ? "page" : undefined}
      >
        <Show when={props.item.icon == "indirect-code"} fallback={
          <Icon name={props.item.icon} size={17} />
        }>
          <img
            src="/indirect-icon.svg"
            alt="Indirect"
            class="w-[17px] h-[17px] shrink-0 object-contain rounded"
          />
        </Show>
        <span class="hidden lg:block text-xs font-medium truncate">{props.item.label}</span>
        <Show when={(props.badge ?? 0) > 0}>
          <span class="hidden lg:inline-flex lg:ml-auto min-w-4 h-4 px-1.5 items-center justify-center rounded-md bg-elev border border-line text-ink-400 text-[10px] font-mono leading-none tabular-nums">
            {props.badge}
          </span>
        </Show>
      </a>
  );
}

function AppShell(props: { children: JSX.Element }) {
  createEffect(() => setMotionEnabled(route().path !== "/code"));
  onCleanup(() => setMotionEnabled(true));
  const user = () => currentSession()!.user;
  const [mobileNav, setMobileNav] = createSignal(false);

  const [keys] = createResource(async () => {
    try {
      const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
      return j.keys;
    } catch {
      return [] as ApiKeyDto[];
    }
  });

  const activeKeyCount = createMemo(
    () => (keys() ?? []).filter((k) => k.status === "active").length,
  );
  const info = createMemo(() => pageInfo(route().path));

  const logout = async () => {
    try {
      await api("POST", "/api/auth/logout");
    } catch {}
    setSession(null);
    toast("Signed out");
  };

  // Close the mobile drawer on navigation.
  createEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- read inside the effect so route changes re-trigger
    route().path;
    setMobileNav(false);
  });

  const mobileLink = (item: NavItem) => (
    <a
      href={`#${item.path}`}
      class={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm transition-colors ${
        isActive(item, route().path)
          ? "bg-brand-500/10 text-brand-500 font-semibold"
          : "text-ink-300 hover:bg-ink-800/60 hover:text-ink-100"
      }`}
    >
      <Show when={item.icon == "indirect-code"} fallback={
         <Icon name={item.icon} size={20} />
        }>
          <img
            src="/indirect-icon.svg"
            alt="Indirect"
            class="w-[20px] h-[20px] shrink-0 object-contain rounded"
          />
      </Show>
      {item.label}
    </a>
  );

  return (
    <div class="gw-shell min-h-screen">
      {/* ===== desktop icon rail ===== */}
      <aside class="gateway-rail hidden md:flex fixed inset-y-0 left-0 w-16 lg:w-64 flex-col items-center py-4 border-r border-line z-30">
        <a href="#/" class="gw-rail-brand flex items-center gap-2.5 lg:w-60 lg:px-2" aria-label="Indirect Gateway">
          <img
        src="/indirect-icon.svg"
        alt="Indirect"
        class="w-8 h-8 shrink-0 object-contain rounded"
      />
          <span class="hidden lg:block truncate text-[13px] font-semibold tracking-tight font-mono uppercase">Indirect Gateway</span>
        </a>
        <nav
          class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-1 mt-6"
          aria-label="Main navigation"
        >
          <For each={USER_NAV}>
            {(item) => (
              <RailItem
                item={item}
                current={route().path}
                badge={item.path === "/keys" ? activeKeyCount() : 0}
              />
            )}
          </For>
          <Show when={user().role === "admin"}>
            <span class="w-6 lg:w-56 h-px bg-line mt-4 mb-2 shrink-0" />
            <span class="hidden lg:block w-60 px-2.5 pb-1 text-[10px] font-medium text-ink-500">Administration</span>
            <For each={ADMIN_NAV}>
              {(item) => <RailItem item={item} current={route().path} />}
            </For>
          </Show>
        </nav>
        <div class="flex items-center justify-center lg:justify-start lg:w-60 lg:px-2 pt-3">
          <Tooltip content="Sign out" placement="right" delay={50}>
            <button
              onClick={logout}
              class="flex h-9 w-9 items-center justify-center rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
              aria-label="Sign out"
            >
              <Icon name={Icons.logout} size={17} />
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* ===== mobile top bar ===== */}
      <div class="gw-header md:hidden sticky top-0 z-40 border-b border-line bg-ink-950/90 backdrop-blur">
        <div class="gw-mobile-header flex items-center justify-between h-14 px-4">
          <a href="#/" class="gw-mobile-brand flex items-center gap-2.5" aria-label="Indirect Gateway">
            <img
              src="/indirect-icon.svg"
              alt="Indirect"
              class="w-8 h-8 shrink-0 object-contain rounded"
            />
            <span class="truncate text-[13px] font-semibold tracking-tight font-mono uppercase">
              Indirect Gateway
            </span>
          </a>
          <div class="gw-mobile-actions flex items-center gap-1">
            <button
              class="flex h-10 w-10 items-center justify-center rounded-xl text-ink-300 hover:bg-ink-800/60 transition-colors cursor-pointer"
              onClick={() => setMobileNav(!mobileNav())}
              aria-label="Menu"
            >
              <Icon name={mobileNav() ? Icons.x : Icons.menu} size={20} />
            </button>
          </div>
        </div>
        <Show when={mobileNav()}>
          <div class="border-t border-line anim-fade-in px-3 py-3 space-y-0.5 max-h-[70vh] overflow-y-auto">
            <For each={USER_NAV}>{mobileLink}</For>
            <Show when={user().role === "admin"}>
              <div class="px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Administration
              </div>
              <For each={ADMIN_NAV}>{mobileLink}</For>
            </Show>
            <button
              onClick={logout}
              class="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
            >
              <Icon name={Icons.logout} size={20} />
              Sign out
            </button>
          </div>
        </Show>
      </div>

      <main class="md:pl-16 lg:pl-64">
        {/* ===== desktop header ===== */}
        <header
          class="gw-header hidden md:flex sticky top-0 z-20 h-14 items-center justify-between gap-4 border-b border-line bg-ink-950/95 backdrop-blur px-6"
        >
          <div class="flex items-center gap-2.5 min-w-0 text-xs">
            <span class="text-ink-500">{route().path.startsWith("/admin") ? "Administration" : "Workspace"}</span>
            <span class="text-ink-600" aria-hidden="true">/</span>
            <span class="text-ink-200 font-medium truncate">{info().label}</span>
          </div>
          <div class="gw-user flex items-center gap-3 shrink-0">
            <div class="hidden lg:block text-right mr-1">
              <div class="text-xs font-semibold truncate max-w-44">
                {user().name || user().email}
              </div>
              <div class="gw-user-email text-[11px] text-ink-500 truncate max-w-44">
                {user().email}
              </div>
            </div>
            <div class="gw-user-avatar w-8 h-8 rounded-lg border border-line bg-card text-ink-300 flex items-center justify-center text-xs font-medium">
              {(user().name || user().email).slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <div class="mx-auto max-w-7xl px-4 sm:px-6 py-6">
          {props.children}
        </div>
      </main>
    </div>
  );
}

function Root() {
  const [tick, setTick] = createSignal(0);
  const off = onSessionChange(() => setTick((t) => t + 1));
  onCleanup(off);
  onMount(() => watchSystemTheme());

  // Per-page title + favicon (must live in Root: /code renders OUTSIDE
  // AppShell, so an effect there would unmount on exactly the page that
  // needs it). The init script in index.html honors window.__pageIcon.
  createEffect(() => {
    const p = route().path;
    try {
      if (p === "/code-dev" || p.startsWith("/code-dev") || p === "/codedev" || p.startsWith("/codedev")) {
        document.title = "Indirect Code — Dev Mode";
        (window as any).__pageIcon = "/indirect-icon.svg";
      } else if (p.startsWith("/code")) {
        document.title = "Indirect Code";
        (window as any).__pageIcon = "/indirect-icon.svg";
      } else {
        document.title = "Indirect Gateway";
        (window as any).__pageIcon = "/indirect-icon.svg";
      }
      // Re-run the init-script sync (theme observer keeps working after).
      (window as any).__syncFavicon?.();
    } catch {}
  });

  const current = () => {
    void tick();
    return { r: route(), s: currentSession() };
  };

  return (
    <>
      <Show
        when={
          current().s || ["/login", "/set-password"].includes(current().r.path)
        }
        fallback={<LoginPage />}
      >
        <Show
          when={!["/login", "/set-password"].includes(current().r.path)}
          fallback={
            current().r.path === "/set-password" ? (
              <SetPasswordPage query={current().r.query} />
            ) : (
              <LoginPage />
            )
          }
        >
          {(() => {
            const p = route().path;
            if (p === "/code-dev" || p.startsWith("/code-dev") || p === "/codedev" || p.startsWith("/codedev")) {
              return <RouteChunk><CodeDevPage /></RouteChunk>;
            }
            if (p.startsWith("/code")) {
              return <RouteChunk><IndirectCodePage /></RouteChunk>;
            }
            return (
              <AppShell>
                <RouteChunk>{(() => {
                  const isAdmin = currentSession()?.user.role === "admin";
                  if (p === "/") return <DashboardPage />;
                  if (p === "/keys") return <KeysPage />;
                  if (p === "/usage") return <UsagePage />;
                  if (p === "/limits") return <PlanLimits />;
                  if (p === "/settings") return <SettingsPage />;
                  if (p === "/projects") return <ProjectsPage />;
                  if (p.startsWith("/admin") && !isAdmin) return <div class="space-y-3"><h1 class="text-2xl font-semibold">Administration access required</h1><p role="alert" class="text-sm text-ink-400">Your account does not have permission to use this page.</p><a href="#/projects" class="text-accent-500 underline">Open your financial projects</a></div>;
                  if (p.startsWith("/admin") && isAdmin) {
                    if (p === "/admin" || p === "/admin/stats")
                      return <AdminStatsPage />;
                    if (p === "/admin/providers") return <AdminProvidersPage />;
                    if (p === "/admin/models") return <AdminModelsPage />;
                    if (p === "/admin/plans") return <AdminPlansPage />;
                    if (p === "/admin/users") return <AdminUsersPage />;
                    if (p === "/admin/keys") return <AdminKeysPage />;
                    if (p === "/admin/audit") return <AdminAuditPage />;
                    if (p === "/admin/organization") return <OrganizationPage />;
                  }
                  return <DashboardPage />;
                })()}</RouteChunk>
              </AppShell>
            );
          })()}
        </Show>
      </Show>
      <Toasts />
    </>
  );
}

// Boot hook: after a fresh login, route away from /login.
createEffect(() => {
  if (currentSession() && ["/login", "/set-password"].includes(route().path)) {
    navigate("/");
  }
});

render(() => <Root />, document.getElementById("app")!);
