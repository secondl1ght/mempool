import { PoolInfo, PoolStats } from '../mempool.interfaces';
import BlocksRepository, { EmptyBlocks } from '../repositories/BlocksRepository';
import PoolsRepository from '../repositories/PoolsRepository';
import HashratesRepository from '../repositories/HashratesRepository';
import bitcoinClient from './bitcoin/bitcoin-client';
import logger from '../logger';
import blocks from './blocks';

class Mining {
  hashrateIndexingStarted = false;

  constructor() {
  }

  /**
   * Generate high level overview of the pool ranks and general stats
   */
  public async $getPoolsStats(interval: string | null): Promise<object> {
    const poolsStatistics = {};

    const poolsInfo: PoolInfo[] = await PoolsRepository.$getPoolsInfo(interval);
    const emptyBlocks: EmptyBlocks[] = await BlocksRepository.$getEmptyBlocks(null, interval);

    const poolsStats: PoolStats[] = [];
    let rank = 1;

    poolsInfo.forEach((poolInfo: PoolInfo) => {
      const poolStat: PoolStats = {
        poolId: poolInfo.poolId, // mysql row id
        name: poolInfo.name,
        link: poolInfo.link,
        blockCount: poolInfo.blockCount,
        rank: rank++,
        emptyBlocks: 0
      };
      for (let i = 0; i < emptyBlocks.length; ++i) {
        if (emptyBlocks[i].poolId === poolInfo.poolId) {
          poolStat.emptyBlocks++;
        }
      }
      poolsStats.push(poolStat);
    });

    poolsStatistics['pools'] = poolsStats;
    poolsStatistics['oldestIndexedBlockTimestamp'] = await BlocksRepository.$oldestBlockTimestamp();

    const blockCount: number = await BlocksRepository.$blockCount(null, interval);
    poolsStatistics['blockCount'] = blockCount;

    const blockHeightTip = await bitcoinClient.getBlockCount();
    const lastBlockHashrate = await bitcoinClient.getNetworkHashPs(144, blockHeightTip);
    poolsStatistics['lastEstimatedHashrate'] = lastBlockHashrate;

    return poolsStatistics;
  }

  /**
   * Get all mining pool stats for a pool
   */
  public async $getPoolStat(interval: string | null, poolId: number): Promise<object> {
    const pool = await PoolsRepository.$getPool(poolId);
    if (!pool) {
      throw new Error(`This mining pool does not exist`);
    }

    const blockCount: number = await BlocksRepository.$blockCount(poolId, interval);
    const emptyBlocks: EmptyBlocks[] = await BlocksRepository.$getEmptyBlocks(poolId, interval);

    return {
      pool: pool,
      blockCount: blockCount,
      emptyBlocks: emptyBlocks,
    };
  }

  /**
   * Return the historical difficulty adjustments and oldest indexed block timestamp
   */
  public async $getHistoricalDifficulty(interval: string | null): Promise<object> {
    return await BlocksRepository.$getBlocksDifficulty(interval);
  }

  /**
   * Return the historical hashrates and oldest indexed block timestamp
   */
  public async $getNetworkHistoricalHashrates(interval: string | null): Promise<object> {
    return await HashratesRepository.$getNetworkDailyHashrate(interval);
  }

  /**
   * Return the historical hashrates and oldest indexed block timestamp for one or all pools
   */
  public async $getPoolsHistoricalHashrates(interval: string | null, poolId: number): Promise<object> {
    return await HashratesRepository.$getPoolsWeeklyHashrate(interval);
  }

  /**
   * Generate daily hashrate data
   */
  public async $generateNetworkHashrateHistory(): Promise<void> {
    // We only run this once a day
    const latestTimestamp = await HashratesRepository.$getLatestRunTimestamp();
    const now = new Date().getTime() / 1000;
    if (now - latestTimestamp < 86400) {
      return;
    }

    if (!blocks.blockIndexingCompleted || this.hashrateIndexingStarted) {
      return;
    }

    try {
      this.hashrateIndexingStarted = true;

      logger.info(`Indexing hashrates`);

      const totalDayIndexed = (await BlocksRepository.$blockCount(null, null)) / 144;
      const indexedTimestamp = (await HashratesRepository.$getNetworkDailyHashrate(null)).map(hashrate => hashrate.timestamp);
      let startedAt = new Date().getTime() / 1000;
      const genesisTimestamp = 1231006505; // bitcoin-cli getblock 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f
      const lastMidnight = new Date();
      lastMidnight.setUTCHours(0); lastMidnight.setUTCMinutes(0); lastMidnight.setUTCSeconds(0); lastMidnight.setUTCMilliseconds(0);
      let toTimestamp = Math.round(lastMidnight.getTime() / 1000);
      let indexedThisRun = 0;
      let totalIndexed = 0;

      const hashrates: any[] = [];

      while (toTimestamp > genesisTimestamp) {
        const fromTimestamp = toTimestamp - 86400;
        if (indexedTimestamp.includes(fromTimestamp)) {
          toTimestamp -= 86400;
          ++totalIndexed;
          continue;
        }

        const blockStats: any = await BlocksRepository.$blockCountBetweenTimestamp(
          null, fromTimestamp, toTimestamp);
        if (blockStats.blockCount === 0) { // We are done indexing, no blocks left
          break;
        }

        let lastBlockHashrate = 0;
        lastBlockHashrate = await bitcoinClient.getNetworkHashPs(blockStats.blockCount,
          blockStats.lastBlockHeight);

        if (totalIndexed > 7 && totalIndexed % 7 === 0 && !indexedTimestamp.includes(fromTimestamp + 1)) { // Save weekly pools hashrate
          logger.debug("Indexing weekly hashrates for mining pools");
          let pools = await PoolsRepository.$getPoolsInfoBetween(fromTimestamp - 604800, fromTimestamp);
          const totalBlocks = pools.reduce((acc, pool) => acc + pool.blockCount, 0);
          pools = pools.map((pool: any) => {
            pool.hashrate = (pool.blockCount / totalBlocks) * lastBlockHashrate;
            pool.share = (pool.blockCount / totalBlocks);
            return pool;
          });

          for (const pool of pools) {
            hashrates.push({
              hashrateTimestamp: fromTimestamp + 1,
              avgHashrate: pool['hashrate'],
              poolId: pool.poolId,
              share: pool['share'],
              type: 'weekly',
            });
          }
        }

        hashrates.push({
          hashrateTimestamp: fromTimestamp,
          avgHashrate: lastBlockHashrate,
          poolId: null,
          share: 1,
          type: 'daily',
        });

        if (hashrates.length > 10) {
          await HashratesRepository.$saveHashrates(hashrates);
          hashrates.length = 0;
        }

        const elapsedSeconds = Math.max(1, Math.round((new Date().getTime() / 1000) - startedAt));
        if (elapsedSeconds > 5) {
          const daysPerSeconds = (indexedThisRun / elapsedSeconds).toFixed(2);
          const formattedDate = new Date(fromTimestamp * 1000).toUTCString();
          const daysLeft = Math.round(totalDayIndexed - totalIndexed);
          logger.debug(`Getting hashrate for ${formattedDate} | ~${daysPerSeconds} days/sec | ~${daysLeft} days left to index`);
          startedAt = new Date().getTime() / 1000;
          indexedThisRun = 0;
        }

        toTimestamp -= 86400;
        ++indexedThisRun;
        ++totalIndexed;
      }

      // Add genesis block manually
      if (toTimestamp <= genesisTimestamp && !indexedTimestamp.includes(genesisTimestamp)) {
        hashrates.push({
          hashrateTimestamp: genesisTimestamp,
          avgHashrate: await bitcoinClient.getNetworkHashPs(1, 1),
          poolId: null,
          type: 'daily',
        });
      }

      if (hashrates.length > 0) {
        await HashratesRepository.$saveHashrates(hashrates);
      }
      await HashratesRepository.$setLatestRunTimestamp();
      this.hashrateIndexingStarted = false;

      logger.info(`Hashrates indexing completed`);
    } catch (e) {
      this.hashrateIndexingStarted = false;
      throw e;
    }
  }
}

export default new Mining();