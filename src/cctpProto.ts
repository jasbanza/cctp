import type { GeneratedType } from "@cosmjs/proto-signing";
import { BinaryReader, BinaryWriter } from "cosmjs-types/binary";

// Hand-written from circlefin/noble-cctp proto/circle/cctp/v1/tx.proto.
export const MsgDepositForBurnTypeUrl = "/circle.cctp.v1.MsgDepositForBurn";

export interface MsgDepositForBurn {
  from: string;
  amount: string;
  destinationDomain: number;
  mintRecipient: Uint8Array;
  burnToken: string;
}

export const MsgDepositForBurn = {
  encode(message: MsgDepositForBurn, writer = BinaryWriter.create()) {
    if (message.from) writer.uint32(10).string(message.from);
    if (message.amount) writer.uint32(18).string(message.amount);
    if (message.destinationDomain) writer.uint32(24).uint32(message.destinationDomain);
    if (message.mintRecipient.length) writer.uint32(34).bytes(message.mintRecipient);
    if (message.burnToken) writer.uint32(42).string(message.burnToken);
    return writer;
  },
  decode(input: Uint8Array): MsgDepositForBurn {
    const reader = new BinaryReader(input);
    const message = MsgDepositForBurn.fromPartial({});
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: message.from = reader.string(); break;
        case 2: message.amount = reader.string(); break;
        case 3: message.destinationDomain = reader.uint32(); break;
        case 4: message.mintRecipient = reader.bytes(); break;
        case 5: message.burnToken = reader.string(); break;
        default: reader.skipType(tag & 7);
      }
    }
    return message;
  },
  fromPartial(object: Partial<MsgDepositForBurn>): MsgDepositForBurn {
    return {
      from: object.from ?? "",
      amount: object.amount ?? "",
      destinationDomain: object.destinationDomain ?? 0,
      mintRecipient: object.mintRecipient ?? new Uint8Array(),
      burnToken: object.burnToken ?? "",
    };
  },
} satisfies GeneratedType;
