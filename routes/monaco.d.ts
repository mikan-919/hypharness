// vite.config.ts の別名 hyph-monaco が指す routes/monaco.mjs の型
declare module 'hyph-monaco' {
  export function mountMonaco(
    element: HTMLElement,
    value: string,
    onChange: (value: string) => void,
  ): Promise<{ setValue(value: string): void; getValue(): string; dispose(): void }>
}
