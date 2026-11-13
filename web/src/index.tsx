import "./fonts.css";

import { render } from "solid-js/web";
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  untrack,
  Show,
  For,
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
  ThemeToggle,
  Toasts,
  Tooltip,
  toast,
  watchSystemTheme,
} from "./ui";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ds/components/menu";
import { Drawer } from "./ds/components/overlay";
import { IconSwap } from "./ds/components/tabs";
import { createGlide } from "./ds/motion/glide";
import LoginPage from "./pages/Login";
import SetPasswordPage from "./pages/SetPassword";
import { PlanLimits } from "./billing";
import { RemoteHints } from "./indirect-code/presentation";
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
function RouteLoading(): JSX.Element {
  return (
    <div class="route-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="route-loading-dot" />
      <span class="route-loading-dot" />
      <span class="route-loading-dot" />
      <span class="sr-only">Loading</span>
    </div>
  );
}

function lazyRoute<T extends (props: any) => JSX.Element>(loader: () => Promise<{ default: T }>): T {
  let cached: T | undefined;
  let pending: Promise<{ default: T }> | undefined;
  return ((props: any) => {
    const [comp, setComp] = createSignal<T | undefined>(cached);
    if (!cached) {
      (pending ??= loader()).then((mod) => {
        cached = mod.default;
        setComp(() => cached);
      });
    }
    return createMemo(() => {
      const C = comp();
      return C ? untrack(() => C(props)) : <RouteLoading />;
    }) as unknown as JSX.Element;
  }) as unknown as T;
}

const DashboardPage = lazyRoute(() => import("./pages/Dashboard"));
const IndirectCodePage = lazyRoute(() => import("./indirect-code/IndirectCodePage"));
const CodeDevPage = lazyRoute(() => import("./indirect-code/CodeDevPage"));
const KeysPage = lazyRoute(() => import("./pages/Keys"));
const UsagePage = lazyRoute(() => import("./pages/Usage"));
const SettingsPage = lazyRoute(() => import("./pages/Settings"));
const AdminProvidersPage = lazyRoute(() => import("./pages/admin/Providers"));
const AdminModelsPage = lazyRoute(() => import("./pages/admin/Models"));
const AdminPlansPage = lazyRoute(() => import("./pages/admin/Plans"));
const AdminUsersPage = lazyRoute(() => import("./pages/admin/Users"));
const AdminKeysPage = lazyRoute(() => import("./pages/admin/Keys"));
const AdminStatsPage = lazyRoute(() => import("./pages/admin/Stats"));
const AdminAuditPage = lazyRoute(() => import("./pages/admin/Audit"));
const ProjectsPage = lazyRoute(() => import("./pages/Projects"));
const OrganizationPage = lazyRoute(() => import("./pages/admin/Organization"));
const GalleryPage = lazyRoute(() => import("./ds/gallery/GalleryPage"));

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
import { noteRouteTransition, routeKind } from "./route-nav";

let lastRoutePath = route().path;
window.addEventListener("hashchange", () => {
  const next = parseHash();
  noteRouteTransition(lastRoutePath, next.path);
  lastRoutePath = next.path;
  setRoute(next);
});

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const USER_NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: Icons.home },
  { path: "/code", label: "Indirect Code", icon: Icons.idc },
  { path: "/keys", label: "API keys", icon: Icons.key },
  { path: "/usage", label: "Usage", icon: Icons.chart },
  { path: "/limits", label: "Plan & limits", icon: "lucide:wallet" },
  { path: "/projects", label: "Financial projects", icon: Icons.folder },
  { path: "/settings", label: "Settings", icon: Icons.cog },
];

/** Administration is grouped by the job an operator is doing, so the rail
 *  separates observability, routing, access and installation configuration
 *  instead of presenting eight unrelated links. */
const ADMIN_GROUPS: NavGroup[] = [
  {
    label: "Observability",
    items: [
      { path: "/admin", label: "Global stats", icon: "lucide:activity" },
      { path: "/admin/audit", label: "Audit log", icon: Icons.book },
    ],
  },
  {
    label: "Routing",
    items: [
      { path: "/admin/providers", label: "Providers", icon: Icons.server },
      { path: "/admin/models", label: "Models", icon: Icons.layers },
    ],
  },
  {
    label: "Access & billing",
    items: [
      { path: "/admin/users", label: "Users", icon: Icons.users },
      { path: "/admin/plans", label: "Plans", icon: "lucide:wallet" },
      { path: "/admin/keys", label: "All keys", icon: Icons.key },
    ],
  },
  {
    label: "Configuration",
    items: [
      { path: "/admin/organization", label: "Organization", icon: "lucide:building-2" },
    ],
  },
];

const ADMIN_NAV: NavItem[] = ADMIN_GROUPS.flatMap((group) => group.items);

function pageInfo(path: string): NavItem {
  if (path === "/ds") return { path: "/ds", label: "Design system", icon: Icons.sparkles };
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
  return <>{props.children}</>;
}

function isActive(item: NavItem, current: string): boolean {
  return item.path === "/"
    ? current === "/"
    : item.path === "/admin"
      ? current === "/admin" || current === "/admin/stats"
      : current.startsWith(item.path);
}

/** Rail link. The active item is marked by the gliding indicator (desktop)
 *  and by accent on its icon; collapsed rails show the label as a tooltip. */
function RailItem(props: { item: NavItem; current: string; badge?: number }) {
  const active = () => isActive(props.item, props.current);
  return (
    <a
      href={`#${props.item.path}`}
      class="gateway-nav relative z-[1] flex h-9 w-9 lg:w-60 items-center justify-center lg:justify-start lg:px-2.5 gap-2.5"
      aria-current={active() ? "page" : undefined}
    >
      <Show when={props.item.icon == "indirect-code"} fallback={
        <span class="gateway-nav-icon inline-flex"><Icon name={props.item.icon} size={17} /></span>
      }>
        <img
          src="/indirect-icon.svg"
          alt=""
          class="w-[17px] h-[17px] shrink-0 object-contain rounded"
        />
      </Show>
      <span class="sr-only lg:not-sr-only lg:block text-sm truncate">{props.item.label}</span>
      <Show when={(props.badge ?? 0) > 0}>
        <span class="hidden lg:inline-flex lg:ml-auto min-w-5 h-5 px-1.5 items-center justify-center rounded-pill bg-surface-muted text-fg-muted text-2xs font-medium leading-none tabular-nums">
          {" "}{props.badge}
        </span>
      </Show>
    </a>
  );
}

function AppShell(props: { children: JSX.Element }) {
  const user = () => currentSession()!.user;
  const [mobileNav, setMobileNav] = createSignal(false);
  const [userMenu, setUserMenu] = createSignal(false);
  const [nav, setNav] = createSignal<HTMLElement>();
  const [navIndicator, setNavIndicator] = createSignal<HTMLSpanElement>();
  const [avatar, setAvatar] = createSignal<HTMLButtonElement>();

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

  // One highlight glides along the rail to the active page.
  createGlide({
    container: nav,
    indicator: navIndicator,
    target: () => {
      void route().path;
      return nav()?.querySelector<HTMLElement>('[aria-current="page"]') ?? null;
    },
  });

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
      aria-current={isActive(item, route().path) ? "page" : undefined}
      class={`flex min-h-11 items-center gap-3 rounded-control px-3 text-sm transition-colors ${
        isActive(item, route().path)
          ? "bg-accent-subtle text-accent-strong font-medium"
          : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
      }`}
    >
      <Show when={item.icon == "indirect-code"} fallback={<Icon name={item.icon} size={18} />}>
        <img src="/indirect-icon.svg" alt="Indirect" class="w-[18px] h-[18px] shrink-0 object-contain rounded" />
      </Show>
      {item.label}
    </a>
  );

  const initial = () => (user().name || user().email).slice(0, 1).toUpperCase();

  return (
    <div class="gw-shell min-h-screen">
      {/* ===== desktop icon rail ===== */}
      <aside class="gateway-rail hidden md:flex fixed inset-y-0 left-0 w-16 lg:w-64 flex-col items-center py-4 border-r border-border z-30">
        <a href="#/" class="gw-rail-brand flex items-center gap-2.5 lg:w-60 lg:px-2" aria-label="Indirect Gateway">
          <img src="/indirect-icon.svg" alt="Indirect" class="gw-rail-logo w-8 h-8 shrink-0 object-contain rounded" />
          <span class="hidden lg:block truncate text-sm font-medium text-fg">Indirect Gateway</span>
        </a>
        <nav
          ref={setNav}
          class="gw-nav relative flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden flex flex-col items-center gap-0.5 mt-6"
          aria-label="Main navigation"
          data-glide=""
        >
          <span ref={setNavIndicator} class="gw-nav-indicator" aria-hidden="true" />
          <For each={USER_NAV}>
            {(item) => (
              <RailItem item={item} current={route().path} badge={item.path === "/keys" ? activeKeyCount() : 0} />
            )}
          </For>
          <Show when={user().role === "admin"}>
            <span class="w-6 lg:w-56 h-px bg-border mt-4 mb-2 shrink-0" />
            <div class="w-full flex flex-col items-center" role="group" aria-label="Administration">
              <For each={ADMIN_GROUPS}>
                {(group, index) => (
                  <div class="gw-nav-group w-full flex flex-col items-center gap-0.5" role="group" aria-label={group.label}>
                    <span class={`gw-nav-group-label hidden lg:block w-60 px-2.5 pt-2 pb-1 text-xs text-fg-muted ${index() === 0 ? "" : "mt-2"}`}>
                      {group.label}
                    </span>
                    <For each={group.items}>
                      {(item) => <RailItem item={item} current={route().path} />}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </nav>
        <div class="flex items-center justify-center lg:justify-start lg:w-60 lg:px-0.5 pt-3">
          <Tooltip content="Sign out" placement="right">
            <button onClick={logout} class="ui-icon-button ui-icon-button-danger" aria-label="Sign out">
              <Icon name={Icons.logout} size={17} />
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* ===== mobile top bar ===== */}
      <div class="gw-header md:hidden sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div class="gw-mobile-header flex items-center justify-between h-14 px-4">
          <a href="#/" class="gw-mobile-brand flex items-center gap-2.5" aria-label="Indirect Gateway">
            <img src="/indirect-icon.svg" alt="Indirect" class="w-8 h-8 shrink-0 object-contain rounded" />
            <span class="truncate text-sm font-medium">Indirect Gateway</span>
          </a>
          <div class="gw-mobile-actions flex items-center gap-1">
            <ThemeToggle />
            <button
              class="ui-icon-button ui-icon-button-md"
              onClick={() => setMobileNav(!mobileNav())}
              aria-label="Menu"
              aria-expanded={mobileNav()}
            >
              <IconSwap icon={mobileNav() ? Icons.x : Icons.menu} size={20} />
            </button>
          </div>
        </div>
      </div>
      <Drawer open={mobileNav()} onClose={() => setMobileNav(false)} label="Navigation" side="left">
        <div class="flex items-center gap-2.5 px-4 pt-[calc(var(--sat)+1rem)] pb-3 border-b border-border-subtle">
          <img src="/indirect-icon.svg" alt="" class="w-7 h-7 shrink-0 object-contain rounded" />
          <span class="text-sm font-medium">Indirect Gateway</span>
        </div>
        <nav class="flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-0.5" aria-label="Main navigation">
          <For each={USER_NAV}>{mobileLink}</For>
          <Show when={user().role === "admin"}>
            <For each={ADMIN_GROUPS}>
              {(group) => (
                <div class="pt-3">
                  <div class="px-3 pb-1 text-xs text-fg-muted">{group.label}</div>
                  <For each={group.items}>{mobileLink}</For>
                </div>
              )}
            </For>
          </Show>
        </nav>
        <div class="border-t border-border-subtle p-3 pb-[calc(var(--sab)+0.75rem)]">
          <button onClick={logout} class="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm text-danger hover:bg-danger-subtle transition-colors cursor-pointer">
            <Icon name={Icons.logout} size={18} />
            Sign out
          </button>
        </div>
      </Drawer>

      <main class="md:pl-16 lg:pl-64">
        {/* ===== desktop header ===== */}
        <header class="gw-header hidden md:flex sticky top-0 z-20 h-14 items-center justify-between gap-4 border-b border-border bg-background/90 backdrop-blur px-6">
          <nav class="flex items-center gap-2 min-w-0 text-sm" aria-label="Breadcrumb">
            <span class="text-fg-muted">{route().path.startsWith("/admin") ? "Administration" : "Workspace"}</span>
            <Icon name={Icons.chevronRight} size={14} class="text-fg-muted" />
            <span class="text-fg font-medium truncate" aria-current="page">{info().label}</span>
          </nav>
          <div class="gw-user flex items-center gap-2 shrink-0">
            <ThemeToggle />
            <button
              ref={setAvatar}
              type="button"
              class="flex items-center gap-2.5 rounded-pill py-1 pl-1 pr-1 lg:pr-3 hover:bg-surface-muted transition-colors cursor-pointer"
              aria-haspopup="menu"
              aria-expanded={userMenu()}
              onClick={() => setUserMenu(!userMenu())}
            >
              <span class="sr-only">Account: </span>
              <span class="gw-user-avatar w-8 h-8 rounded-pill border border-border bg-surface text-fg-secondary flex items-center justify-center text-sm font-medium" aria-hidden="true">
                {initial()}
              </span>
              <span class="hidden lg:block text-left">
                <span class="block text-sm font-medium truncate max-w-44 leading-tight">{user().name || user().email}</span>
                <span class="gw-user-email block text-xs text-fg-muted truncate max-w-44 leading-tight" aria-hidden="true">{user().email}</span>
              </span>
            </button>
            <Menu open={userMenu()} onClose={() => setUserMenu(false)} anchor={avatar} placement="bottom-end" label="Account">
              <MenuLabel>{user().email}</MenuLabel>
              <MenuItem icon={Icons.cog} index={0} onSelect={() => navigate("/settings")}>Settings</MenuItem>
              <MenuItem icon={Icons.key} index={1} onSelect={() => navigate("/keys")}>API keys</MenuItem>
              <MenuSeparator />
              <MenuItem icon={Icons.logout} index={2} danger onSelect={() => void logout()}>Sign out</MenuItem>
            </Menu>
          </div>
        </header>

        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
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
  const activeRouteKind = createMemo(() => routeKind(route().path));

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
            const kind = activeRouteKind();
            if (kind === "code-dev") {
              return <RouteChunk><CodeDevPage /></RouteChunk>;
            }
            if (kind === "code") {
              return <RouteChunk><IndirectCodePage /></RouteChunk>;
            }
            return (
              <AppShell>
                <RouteChunk>{(() => {
                  const p = route().path;
                  const isAdmin = currentSession()?.user.role === "admin";
                  if (p === "/") return <DashboardPage />;
                  if (p === "/keys") return <KeysPage />;
                  if (p === "/usage") return <UsagePage />;
                  if (p === "/limits") return <PlanLimits />;
                  if (p === "/settings") return <SettingsPage />;
                  if (p === "/projects") return <ProjectsPage />;
                  if (p === "/ds") return <GalleryPage />;
                  if (p.startsWith("/admin") && !isAdmin) return <div class="space-y-3"><h1 class="text-2xl font-medium text-fg">Administration access required</h1><p role="alert" class="text-sm text-fg-secondary">Your account does not have permission to use this page.</p><a href="#/projects" class="text-accent underline">Open your financial projects</a></div>;
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
      <RemoteHints />
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
