import { SubmittableExtrinsic } from "@polkadot/api/types";
import Keyring from "@polkadot/keyring";
import { blake2AsHex } from "@polkadot/util-crypto";

import { KeyringPair } from "@polkadot/keyring/types";
import ApiHandler from "./ApiHandler";

import Database from "./db";
import logger from "./logger";

import { NominatorConfig, Stash } from "./types";
import { toDecimals } from "./util";
import { Transform } from "node:stream";

export default class Nominator {
  public currentlyNominating: Stash[] = [];
  public maxNominations: number | "auto";

  private _controller: string;
  private db: Database;
  private handler: ApiHandler;
  private signer: KeyringPair;

  // Use proxy of controller instead of controller directly.
  private _isProxy: boolean;

  constructor(
    handler: ApiHandler,
    db: Database,
    cfg: NominatorConfig,
    networkPrefix = 2
  ) {
    this.handler = handler;
    this.db = db;
    this.maxNominations = cfg.maxNominations || 16;
    this._isProxy = cfg.isProxy || false;

    const keyring = new Keyring({
      type: "sr25519",
    });

    keyring.setSS58Format(networkPrefix);

    this.signer = keyring.createFromUri(cfg.seed);
    this._controller = this._isProxy ? cfg.proxyFor : this.signer.address;
    logger.info(
      `(Nominator::constructor) Nominator signer spawned: ${this.address} | ${
        this._isProxy ? "Proxy" : "Controller"
      }`
    );
  }

  public get address(): string {
    if (this._isProxy) {
      return this.signer.address;
    }

    return this.controller;
  }

  public get controller(): string {
    return this._controller;
  }

  public get isProxy(): boolean {
    return this._isProxy;
  }

  public async stash(): Promise<any> {
    const api = await this.handler.getApi();
    const ledger = await api.query.staking.ledger(this.controller);
    if (!ledger.isSome) {
      logger.warn(`Account ${this.controller} is not a controller account!`);
      return "0x";
    }
    const { stash } = ledger.unwrap();

    return stash;
  }

  public async nominate(targets: Stash[], dryRun = false): Promise<boolean> {
    const now = new Date().getTime();

    if (dryRun) {
      logger.info(`DRY RUN - STUBBING TRANSACTIONS`);
      for (const stash of targets) {
        await this.db.setTarget(this.controller, stash, now);
        await this.db.setLastNomination(this.controller, now);
      }
    } else {
      const api = await this.handler.getApi();

      let tx: SubmittableExtrinsic<"promise">;
      if (this._isProxy) {
        const innerTx = api.tx.staking.nominate(targets);

        const currentBlock = await api.rpc.chain.getBlock();
        const { number } = currentBlock.block.header;
        const callHash = innerTx.method.hash.toString();

        tx = api.tx.proxy.announce(
          this.controller,
          blake2AsHex(innerTx.method.toU8a())
        );
        await this.db.addDelayedTx(
          number.toNumber(),
          this.controller,
          targets,
          callHash
        );

        await tx.signAndSend(this.signer);
      } else {
        logger.info(
          `(Nominator::nominate) Creating extrinsic Staking::nominate from ${this.address} to targets ${targets} at ${now}`
        );
        tx = api.tx.staking.nominate(targets);
        logger.info("(Nominator::nominate} Sending extrinsic to network...");
        await this.sendStakingTx(tx, targets);
      }
    }

    return true;
  }

  public async cancelTx(announcement: {
    real: string;
    callHash: string;
    height: number;
  }): Promise<boolean> {
    const api = await this.handler.getApi();
    const tx = api.tx.proxy.removeAnnouncement(
      announcement.real,
      announcement.callHash
    );

    try {
      const unsub = await tx.signAndSend(this.signer, async (result: any) => {
        // TODO: Check result of Tx - either 'ExtrinsicSuccess' or 'ExtrinsicFail'
        //  - If the extrinsic fails, this needs some error handling / logging added

        const { status } = result;

        logger.info(`(Nominator::cancel) Status now: ${status.type}`);
        if (status.isFinalized) {
          const finalizedBlockHash = status.asFinalized;
          logger.info(
            `(Nominator::cancel) Included in block ${finalizedBlockHash}`
          );

          unsub();
        }
      });
      return true;
    } catch (err) {
      logger.warn(`Nominate tx failed: ${err}`);
      return false;
    }
  }

  sendStakingTx = async (
    tx: SubmittableExtrinsic<"promise">,
    targets: string[]
  ): Promise<boolean> => {
    const now = new Date().getTime();
    const api = await this.handler.getApi();

    try {
      const unsub = await tx.signAndSend(this.signer, async (result: any) => {
        // TODO: Check result of Tx - either 'ExtrinsicSuccess' or 'ExtrinsicFail'
        //  - If the extrinsic fails, this needs some error handling / logging added

        const { status } = result;

        logger.info(`(Nominator::nominate) Status now: ${status.type}`);
        if (status.isFinalized) {
          const finalizedBlockHash = status.asFinalized;
          logger.info(
            `(Nominator::nominate) Included in block ${finalizedBlockHash}`
          );
          this.currentlyNominating = targets;

          // Get the current nominations of an address
          const currentTargets = await this.db.getCurrentTargets(
            this.controller
          );
          // if the current targets is populated, clear it
          if (!!currentTargets.length) {
            logger.info("(Nominator::nominate) Wiping old targets");
            await this.db.clearCurrent(this.controller);
          }

          for (const stash of targets) {
            await this.db.setTarget(this.controller, stash, now);
            await this.db.setLastNomination(this.controller, now);
          }

          const era = (await api.query.staking.activeEra()).toJSON()["index"];
          const decimals = (await this.db.getChainMetadata()).decimals;
          const bonded = toDecimals(
            (await api.query.staking.ledger(this.controller)).toJSON()[
              "active"
            ],
            decimals
          );
          await this.db.setNomination(
            this.address,
            era,
            targets,
            bonded,
            finalizedBlockHash
          );

          unsub();
        }
      });
      return true;
    } catch (err) {
      logger.warn(`Nominate tx failed: ${err}`);
      return false;
    }
  };
}
