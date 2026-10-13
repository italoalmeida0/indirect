import Chart from "chart.js/auto";
(globalThis as any).Chart = Chart;
// Widgets use `import Chart from "chart"` (documented) or a namespace
// import — both must reach the Chart class and its named surface.
export * from "chart.js/auto";
export default Chart;
