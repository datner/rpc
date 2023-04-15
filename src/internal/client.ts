import { flow, pipe } from "@effect/data/Function"
import * as Effect from "@effect/io/Effect"
import * as Query from "@effect/query/Query"
import type { Rpc, RpcClient } from "@effect/rpc/Client"
import type { RpcDataSource } from "@effect/rpc/DataSource"
import { RpcError } from "@effect/rpc/Error"
import type { RpcSchema, RpcService } from "@effect/rpc/Schema"
import { RpcServiceId } from "@effect/rpc/Schema"
import * as codec from "@effect/rpc/internal/codec"
import { RpcRequest } from "@effect/rpc/internal/dataSource"
import * as schema from "@effect/rpc/internal/schema"
import * as Schema from "@effect/schema/Schema"

const unsafeDecode = <S extends RpcService.DefinitionWithId>(schemas: S) => {
  const map = schema.methodClientCodecs(schemas)

  return (method: RpcService.Methods<S>, output: unknown) => {
    const result = map[method as string].output(output)
    if (result._tag !== "Left") {
      return result.right as unknown
    }

    throw "unsafeDecode fail"
  }
}

const makeRecursive = <
  S extends RpcService.DefinitionWithId,
  T extends RpcDataSource<any>,
>(
  schemas: S,
  transport: T,
  prefix = "",
): RpcClient<S, T extends RpcDataSource<infer R> ? R : never> =>
  Object.entries(schemas).reduce(
    (acc, [method, codec]) => ({
      ...acc,
      [method]:
        RpcServiceId in codec
          ? makeRecursive(codec, transport, `${prefix}${method}.`)
          : makeRpc(transport, codec, `${prefix}${method}`),
    }),
    {} as any,
  )

/** @internal */
export const make = <
  S extends RpcService.DefinitionWithId,
  T extends RpcDataSource<any>,
>(
  schemas: S,
  transport: T,
): RpcClient<S, T extends RpcDataSource<infer R> ? R : never> =>
  ({
    ...makeRecursive(schemas, transport),
    _schemas: schemas,
    _unsafeDecode: unsafeDecode(schemas),
  } as any)

const makeRpc = <S extends RpcSchema.Any, TR>(
  dataSource: RpcDataSource<TR>,
  schema: S,
  method: string,
): Rpc<S, TR> => {
  const parseError = codec.decodeEffect(
    "error" in schema ? Schema.union(RpcError, schema.error) : RpcError,
  )
  const parseOutput = codec.decodeEffect(schema.output)

  const parseResponse = flow(
    Query.mapEffect(parseOutput),
    Query.catchAll((e) =>
      Query.fromEffect(Effect.flatMap(parseError(e), Effect.fail)),
    ),
  )

  if ("input" in schema) {
    const encodeInput = codec.encode(schema.input as Schema.Schema<any>)

    const send = (input: unknown) =>
      parseResponse(
        Query.fromRequest(RpcRequest({ _tag: method, input }), dataSource),
      )

    return ((input: any) =>
      pipe(Query.fromEither(encodeInput(input)), Query.flatMap(send))) as any
  }

  return parseResponse(
    Query.fromRequest(RpcRequest({ _tag: method }), dataSource),
  ) as any
}