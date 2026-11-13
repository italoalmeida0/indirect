export function routeKind(path: string): "code-dev" | "code" | "gateway" {
  if (
    path === "/code-dev" ||
    path.startsWith("/code-dev") ||
    path === "/codedev" ||
    path.startsWith("/codedev")
  ) {
    return "code-dev";
  }
  if (path.startsWith("/code")) {
    return "code";
  }
  return "gateway";
}

let enteredCodeFromGatewayRoot = false;
let codeExitHandler: (() => void) | null = null;

export function noteRouteTransition(prevPath: string, nextPath: string): void {
  const prevKind = routeKind(prevPath);
  const nextKind = routeKind(nextPath);
  if (prevKind === "gateway" && nextKind === "code") {
    enteredCodeFromGatewayRoot = prevPath === "/" || prevPath === "";
  } else if (nextKind !== "code") {
    enteredCodeFromGatewayRoot = false;
  }
}

export function consumeEnteredCodeFromGatewayRoot(): boolean {
  const v = enteredCodeFromGatewayRoot;
  enteredCodeFromGatewayRoot = false;
  return v;
}

export function registerCodeExitHandler(fn: (() => void) | null): void {
  codeExitHandler = fn;
}

export function exitCodeToGateway(): void {
  if (codeExitHandler) {
    codeExitHandler();
    return;
  }
  if (typeof location !== "undefined") {
    location.replace("#/");
  }
}

export function handleBackToGatewayClick(e: MouseEvent): void {
  if (
    e.defaultPrevented ||
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  ) {
    return;
  }
  e.preventDefault();
  exitCodeToGateway();
}
