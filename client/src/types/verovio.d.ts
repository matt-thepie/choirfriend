// The verovio package ships no type declarations; this covers what we use.
declare module 'verovio/wasm' {
  const createVerovioModule: () => Promise<unknown>;
  export default createVerovioModule;
}

declare module 'verovio/esm' {
  export interface TimemapEntry {
    qstamp: number;
    tstamp: number;
    tempo?: number;
    on?: string[];
    off?: string[];
    measureOn?: string;
  }
  export class VerovioToolkit {
    constructor(module: unknown);
    setOptions(options: Record<string, unknown>): void;
    loadData(data: string): boolean;
    redoLayout(options?: Record<string, unknown>): void;
    getPageCount(): number;
    renderToSVG(page?: number, xmlDeclaration?: boolean): string;
    renderToMIDI(): string;
    renderToTimemap(options?: { includeMeasures?: boolean; includeRests?: boolean }): TimemapEntry[];
    getMIDIValuesForElement(id: string): { pitch: number; time: number; duration: number } | null;
    getPageWithElement(id: string): number;
    getMEI(options?: Record<string, unknown>): string;
    getLog(): string;
    destroy(): void;
  }
}
