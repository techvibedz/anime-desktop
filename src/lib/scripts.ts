// Re-exports the extractor JS strings from the shared module. These are
// pure strings (no runtime deps) so they ship in the renderer bundle and
// are passed back to the main process via window.pantoufa.scrape().
export * from "../../shared/scrape-scripts";
