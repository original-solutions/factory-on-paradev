// happy-dom 21 names `UnderlyingDefaultSource` from `node:stream/web`, which @types/node 22 does
// not declare yet; it is the source shape @types/node calls `UnderlyingSource`.
import type { UnderlyingSource } from "node:stream/web";

declare module "node:stream/web" {
  interface UnderlyingDefaultSource<R = any> extends UnderlyingSource<R> {}
}
