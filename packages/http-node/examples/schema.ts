import * as RS from "@effect/rpc-http-node/Schema"
import * as S from "@effect/schema/Schema"
import { pipe } from "@effect/data/Function"
// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Brand } from "@effect/data/Brand"
// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Chunk } from "@effect/data/Chunk"

export const UserId = pipe(S.number, S.int(), S.brand("UserId"))
export type UserId = S.To<typeof UserId>

const User = S.struct({
  id: UserId,
  name: S.string,
})

export const schema = RS.make({
  getUserIds: {
    output: S.chunk(UserId),
  },
  getUser: {
    input: UserId,
    output: User,
  },
})
