/** SSE fixture 以文本形式内联（esbuild --loader:.sse=text） */
declare module '*.sse' {
  const content: string;
  export default content;
}
