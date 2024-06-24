const { request, gql } = require('graphql-request');
const sdk = require('@defillama/sdk');
const axios = require('axios');
const utils = require('../utils');

const urlMoonbeam = 'https://api.studio.thegraph.com/proxy/78672/pulsar/v0.0.1/';
const urlBlocksSubgraph = 'https://api.thegraph.com/subgraphs/name/stellaswap/pulsar-blocks';

const queryPools = gql`
  {
    pools(first: 1000, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      volumeUSD
      token0 {
        id
        symbol
        decimals
      }
      token1 {
        id
        symbol
        decimals
      }
      totalValueLockedToken0
      totalValueLockedToken1
      totalValueLockedUSD
      feesUSD
      feesToken0
      feesToken1
      token0Price
      token1Price
      tick
      liquidity
    }
  }
`;

const queryPrior = gql`
  {
    pools(first: 1000, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      volumeUSD
      feesToken0
      feesToken1
      token0Price
      token1Price
    }
  }
`;

const tickToSqrtPrice = (tick) => {
  return Math.sqrt(1.0001 ** tick);
};

const getAmounts = (liquidity, tickLower, tickUpper, currentTick) => {
  const currentPrice = tickToSqrtPrice(currentTick);
  const lowerPrice = tickToSqrtPrice(tickLower);
  const upperPrice = tickToSqrtPrice(tickUpper);
  let amount1, amount0;
  if (currentPrice < lowerPrice) {
    amount1 = 0;
    amount0 = liquidity * (1 / lowerPrice - 1 / upperPrice);
  } else if ((lowerPrice <= currentPrice) && (currentPrice <= upperPrice)) {
    amount1 = liquidity * (currentPrice - lowerPrice);
    amount0 = liquidity * (1 / currentPrice - 1 / upperPrice);
  } else {
    amount1 = liquidity * (upperPrice - lowerPrice);
    amount0 = 0;
  }
  return { amount0, amount1 };
};

const fetchWithRetry = async (url, query, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await request(url, query);
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw error;
      }
      await new Promise(res => setTimeout(res, 1000 * attempt)); // Exponential backoff
    }
  }
};

const getPreviousBlockNumber = async (aprDelta, blockDelta, startBlock) => {
  const previousDate = Math.floor(Date.now() / 1000) - aprDelta;
  const queryString = gql`
  {
    blocks(
      first: 1
      orderBy: timestamp
      orderDirection: desc
      where: { timestamp_lt: ${previousDate}, timestamp_gt: ${previousDate - blockDelta} }
    ) {
      number
    }
  }`;
  const response = await fetchWithRetry(urlBlocksSubgraph, queryString);
  const blockNumber = response.blocks[0]?.number === undefined ? startBlock : response.blocks[0]?.number;
  return blockNumber;
};

const getPositionsOfPool = async (poolId) => {
  const result = [];
  let i = 0;
  while (true) {
    const queryString = gql`
    query {
      positions(first: 1000, skip: ${i * 1000}, where: { liquidity_gt: 0, pool: "${poolId}" }) {
        id
        owner
        tickLower {
          tickIdx
        }
        tickUpper {
          tickIdx
        }
        liquidity
        depositedToken0
        depositedToken1
        token0 {
          decimals
        }
        token1 {
          decimals
        }
        pool {
          id
          token0Price
        }
      }
    }`;
    const positions = await fetchWithRetry(urlMoonbeam, queryString);
    result.push(...positions.positions);
    if (positions.positions.length < 1000) {
      break;
    }
    i += 1;
  }
  return result;
};

const topLvl = async (chainString, timestamp, url) => {
  const aprDelta = 259200;
  const blockDelta = 60;
  const startBlock = 2649799;

  const prevBlockNumber = await getPreviousBlockNumber(aprDelta, blockDelta, startBlock);

  const queryPoolsPrior = gql`
  {
    pools(block: { number: ${prevBlockNumber} }, first: 1000, orderBy: id) {
      feesToken0
      feesToken1
      id
      token0 {
        name
        decimals
      }
      token1 {
        name
        decimals
      }
      token0Price
      tick
      liquidity
    }
  }`;
  const responsePrior = await fetchWithRetry(url, queryPoolsPrior);
  const dataPrior = responsePrior.pools;

  let data = (await fetchWithRetry(url, queryPools)).pools;

  const balanceCalls = [];
  for (const pool of data) {
    balanceCalls.push({
      target: pool.token0.id,
      params: pool.id,
    });
    balanceCalls.push({
      target: pool.token1.id,
      params: pool.id,
    });
  }

  const tokenBalances = await sdk.api.abi.multiCall({
    abi: 'erc20:balanceOf',
    calls: balanceCalls,
    chain: chainString,
    permitFailure: true,
  });

  data = data.map((p) => {
    const x = tokenBalances.output.filter((i) => i.input.params[0] === p.id);
    return {
      ...p,
      reserve0:
        x.find((i) => i.input.target === p.token0.id)?.output / `1e${p.token0.decimals}` || 0,
      reserve1:
        x.find((i) => i.input.target === p.token1.id)?.output / `1e${p.token1.decimals}` || 0,
    };
  });

  data = await utils.tvl(data, chainString);

  const poolsFees = {};
  const poolsCurrentTvl = {};

  for (const pool of data) {
    const currentFeesInToken0 = parseFloat(pool.feesToken0) + (parseFloat(pool.feesToken1) * parseFloat(pool.token0Price));
    const priorData = dataPrior.find(dp => dp.id === pool.id);
    const priorFeesInToken0 = priorData ? (parseFloat(priorData.feesToken0) + (parseFloat(priorData.feesToken1) * parseFloat(priorData.token0Price))) : 0;
    const feesIn24Hours = currentFeesInToken0 - priorFeesInToken0;

    poolsFees[pool.id] = feesIn24Hours;
    poolsCurrentTvl[pool.id] = 0;

    const positionsJson = await getPositionsOfPool(pool.id);
    for (const position of positionsJson) {
      const currentTick = parseFloat(pool.tick);
      const { amount0, amount1 } = getAmounts(
        parseFloat(position.liquidity),
        parseFloat(position.tickLower.tickIdx),
        parseFloat(position.tickUpper.tickIdx),
        currentTick,
      );
      const adjustedAmount0 = amount0 / (10 ** parseFloat(position.token0.decimals));
      const adjustedAmount1 = amount1 / (10 ** parseFloat(position.token1.decimals));
      poolsCurrentTvl[pool.id] += adjustedAmount0;
      poolsCurrentTvl[pool.id] += adjustedAmount1 * parseFloat(pool.token0Price);
    }
  }

  const poolsAPR = {};
  for (const pool of data) {
    if (poolsCurrentTvl[pool.id] !== 0) {
      poolsAPR[pool.id] = ((poolsFees[pool.id] * 365) / poolsCurrentTvl[pool.id]) * 100;
    } else {
      poolsAPR[pool.id] = 0;
    }
  }

  data = data.map((p) => {
    // Calculate APR and APY
    const apr = poolsAPR[p.id];
    const apy = (Math.pow(1 + apr / 365, 365) - 1) * 100;

    return {
      pool: p.id,
      chain: utils.formatChain(chainString),
      project: 'stellaswap-v3',
      symbol: `${p.token0.symbol}-${p.token1.symbol}`,
      tvlUsd: parseFloat(p.totalValueLockedUSD),
      apyBase: isNaN(apy) ? 0 : apy,
      apr: isNaN(apr) ? 0 : apr,
      underlyingTokens: [p.token0.id, p.token1.id],
      url: `https://stellaswap.com/pools/${p.id}`,
    };
  });

  // Filter out pools with invalid or missing fields
  data = data.filter(p => p.pool && p.chain && p.project && p.symbol && p.underlyingTokens.length && p.url);

  return data;
};

const main = async (timestamp = null) => {
  const data = await Promise.all([topLvl('moonbeam', timestamp, urlMoonbeam)]);
  return data.flat().filter((p) => utils.keepFinite(p));
};

module.exports = {
  timetravel: false,
  apy: main,
  url: 'https://stellaswap.com/',
};
