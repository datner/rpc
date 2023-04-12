import * as Chunk from "@effect/data/Chunk"
import * as Either from "@effect/data/Either"
import { identity, pipe } from "@effect/data/Function"
import * as Effect from "@effect/io/Effect"
import * as Query from "@effect/query/Query"
import type { RpcRequest } from "@effect/rpc/DataSource"
import type { RpcNotFound } from "@effect/rpc/Error"
import type {
  RpcRequestSchema,
  RpcSchema,
  RpcService,
} from "@effect/rpc/Schema"
import type {
  RpcHandler,
  RpcHandlers,
  RpcRouter,
  RpcUndecodedClient,
} from "@effect/rpc/Server"
import * as codec from "@effect/rpc/internal/codec"
import { decode, encode } from "@effect/rpc/internal/codec"
import * as dataSource from "@effect/rpc/internal/dataSource"
import { methodsMap } from "@effect/rpc/internal/schema"
import * as Schema from "@effect/schema/Schema"

/** @internal */
export const schemaHandlersMap = <H extends RpcHandlers>(
  handlers: H,
  prefix = "",
): Record<string, RpcHandler.Any> =>
  Object.entries(handlers).reduce((acc, [method, definition]) => {
    if ("handlers" in definition) {
      return {
        ...acc,
        ...schemaHandlersMap(definition.handlers, `${prefix}${method}.`),
      }
    }
    return { ...acc, [`${prefix}${method}`]: definition }
  }, {})

/** @internal */
const responseEncoder = Schema.encode(dataSource.RpcResponse)

/** @internal */
export const handleSingleRequest = <R extends RpcRouter.Base>(
  router: R,
): ((request: {
  readonly _tag: string
  readonly input?: unknown
}) => Effect.Effect<RpcHandlers.Services<R["handlers"]>, never, unknown>) => {
  const schemaMap = methodsMap(router.schema)
  const handlerMap = schemaHandlersMap(router.handlers)

  return (request) =>
    pipe(
      Either.Do(),
      Either.bind("schema", () =>
        Either.fromNullable(
          schemaMap[request._tag],
          (): RpcNotFound => ({
            _tag: "RpcNotFound",
            method: request._tag,
          }),
        ),
      ),
      Either.bind("handler", () =>
        Either.fromNullable(
          handlerMap[request._tag],
          (): RpcNotFound => ({
            _tag: "RpcNotFound",
            method: request._tag,
          }),
        ),
      ),
      Either.bind("input", ({ handler, schema }) =>
        !Effect.isEffect(handler) && "input" in schema
          ? decode(schema.input as Schema.Schema<any>)(request.input)
          : Either.right(null),
      ),
      Either.map(({ handler, input, schema }) => {
        const effect: Effect.Effect<any, unknown, unknown> = Effect.isEffect(
          handler,
        )
          ? handler
          : (handler as any)(input)

        return pipe(
          effect,
          Effect.map(encode(schema.output)),
          Effect.catchAll((_) =>
            Effect.succeed(
              Either.flatMap(
                encode(
                  "error" in schema ? schema.error : (Schema.never as any),
                )(_),
                Either.left,
              ),
            ),
          ),
        )
      }),
      Either.match(
        (_) => Effect.succeed(responseEncoder(Either.left(_))),
        identity,
      ),
    )
}

/** @internal */
export const handleRequestUnion = <R extends RpcRouter.Base>(router: R) => {
  const handlerMap = schemaHandlersMap(router.handlers)

  return <Req extends RpcRequestSchema.To<R["schema"]>>(
    request: Req,
  ): Req extends { _tag: infer M }
    ? RpcHandler.FromMethod<M, R["handlers"]>
    : never => {
    const handler = handlerMap[(request as RpcRequest)._tag]
    if (Effect.isEffect(handler)) {
      return handler as any
    }
    return (handler as any)((request as RpcRequest).input) as any
  }
}

/** @internal */
export const router = <
  S extends RpcService.DefinitionWithId,
  H extends RpcHandlers.FromService<S>,
>(
  schema: S,
  handlers: H,
): RpcRouter<S, H> => ({
  schema,
  handlers,
  undecoded: makeUndecodedClient(schema, handlers),
})

/** @internal */
export const handler = <R extends RpcRouter.Base>(
  router: R,
): ((
  u: unknown,
) => Effect.Effect<RpcHandlers.Services<R["handlers"]>, never, unknown>) => {
  const handler = handleSingleRequest(router)

  return (u) =>
    pipe(
      codec.requestDecoder(u),
      Effect.orDie,
      Effect.flatMap((requests) => Effect.collectAllPar(requests.map(handler))),
      Effect.map(Chunk.toReadonlyArray),
    )
}

/** @internal */
export const handlerRaw: <R extends RpcRouter.Base>(
  router: R,
) => <Req extends RpcRequestSchema.To<R["schema"]>>(
  request: Req,
) => Req extends { _tag: infer M }
  ? RpcHandler.FromMethod<M, R["handlers"]>
  : never = handleRequestUnion as any

/** @internal */
export const makeUndecodedClient = <
  S extends RpcService.DefinitionWithId,
  H extends RpcHandlers.FromService<S>,
>(
  schemas: S,
  handlers: H,
): RpcUndecodedClient<H> =>
  Object.entries(handlers as RpcHandlers).reduce(
    (acc, [method, definition]) => {
      if ("handlers" in definition) {
        return {
          ...acc,
          [method]: makeUndecodedClient(
            schemas[method] as any,
            definition.handlers as any,
          ),
        }
      }

      const schema = schemas[method] as RpcSchema.Any

      if (Effect.isEffect(definition)) {
        return {
          ...acc,
          [method]: pipe(
            definition,
            Effect.flatMap(codec.encodeEffect(schema.output)),
            Query.fromEffect,
          ),
        }
      }

      return {
        ...acc,
        [method]: (input: unknown) =>
          pipe(
            (definition as RpcHandler.IO<any, any, any, any>)(input),
            Effect.flatMap(codec.encodeEffect(schema.output)),
            Query.fromEffect,
          ),
      }
    },
    {} as any,
  )
