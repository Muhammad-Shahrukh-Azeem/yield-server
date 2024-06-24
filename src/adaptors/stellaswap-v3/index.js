const { request, gql } = require('graphql-request');
const axios = require('axios');
const sdk = require('@defillama/sdk');
const BigNumber = require('bignumber.js');
const utils = require('../utils');

const urlMoonbeam = 'https://api.studio.thegraph.com/proxy/78672/pulsar/v0.0.1/';
const urlBlocksSubgraph = 'https://api.thegraph.com/subgraphs/name/stellaswap/pulsar-blocks';
const urlConliqSubgraph = 'https://api.thegraph.com/subgraphs/name/stellaswap/pulsar';
const urlFarmingSubgraph = 'https://api.thegraph.com/subgraphs/name/stellaswap/pulsar-farming';
const aprApiUrl = 'https://apr-api.stellaswap.com/api/v1/eternalAPR';

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
  return new BigNumber(Math.sqrt(1.0001 ** tick));
};

const getAmounts = (liquidity, tickLower, tickUpper, currentTick) => {
  const currentPrice = tickToSqrtPrice(currentTick);
  const lowerPrice = tickToSqrtPrice(tickLower);
  const upperPrice = tickToSqrtPrice(tickUpper);
  let amount1, amount0;
  if (currentPrice.isLessThan(lowerPrice)) {
    amount1 = new BigNumber(0);
    amount0 = liquidity.times(new BigNumber(1).div(lowerPrice).minus(new BigNumber(1).div(upperPrice)));
  } else if (currentPrice.isGreaterThanOrEqualTo(lowerPrice) && currentPrice.isLessThanOrEqualTo(upperPrice)) {
    amount1 = liquidity.times(currentPrice.minus(lowerPrice));
    amount0 = liquidity.times(new BigNumber(1).div(currentPrice).minus(new BigNumber(1).div(upperPrice)));
  } else {
    amount1 = liquidity.times(upperPrice.minus(lowerPrice));
    amount0 = new BigNumber(0);
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
    const positions = await fetchWithRetry(urlConliqSubgraph, queryString);
    result.push(...positions.positions);
    if (positions.positions.length < 1000) {
      break;
    }
    i += 1;
  }
  return result;
};

const fetchAprData = async () => {
  try {
    const response = await axios.get(aprApiUrl);
    return response.data.result.farmPools;
  } catch (error) {
    console.error(`Failed to fetch APR data: ${error.message}`);
    return {};
  }
};

const calculateAPR = (totalReward, totalNativeAmount) => {
  const secondsInDay = 86400;
  const daysInYear = 365;
  if (totalNativeAmount.isGreaterThan(0)) {
    return totalReward.dividedBy(totalNativeAmount).times(secondsInDay).times(daysInYear).times(100);
  }
  return new BigNumber(0);
};

const topLvl = async (chainString, timestamp, url) => {
  const aprDelta = 259200;
  const blockDelta = 60;
  const startBlock = 2649799;

  const aprData = await fetchAprData();

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
  const responsePrior = await fetchWithRetry(urlConliqSubgraph, queryPoolsPrior);
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
      reserve0: new BigNumber(x.find((i) => i.input.target === p.token0.id)?.output || 0).div(new BigNumber(10).pow(p.token0.decimals)),
      reserve1: new BigNumber(x.find((i) => i.input.target === p.token1.id)?.output || 0).div(new BigNumber(10).pow(p.token1.decimals)),
    };
  });

  data = await utils.tvl(data, chainString);

  const poolsFees = {};
  const poolsCurrentTvl = {};
  const ratioMultiplier = new BigNumber(1e18); // ratio is in 0.0000s, this is to get at least 18 decimals figure

  for (const pool of data) {
    const currentFeesInToken0 = new BigNumber(pool.feesToken0).plus(new BigNumber(pool.feesToken1).times(new BigNumber(pool.token0Price)));
    const priorData = dataPrior.find(dp => dp.id === pool.id);
    const priorFeesInToken0 = priorData ? new BigNumber(priorData.feesToken0).plus(new BigNumber(priorData.feesToken1).times(new BigNumber(priorData.token0Price))) : new BigNumber(0);
    const feesIn24Hours = currentFeesInToken0.minus(priorFeesInToken0);

    poolsFees[pool.id] = feesIn24Hours;
    poolsCurrentTvl[pool.id] = new BigNumber(0);

    const positionsJson = await getPositionsOfPool(pool.id);
    for (const position of positionsJson) {
      const currentTick = new BigNumber(pool.tick);
      const { amount0, amount1 } = getAmounts(
        new BigNumber(position.liquidity),
        new BigNumber(position.tickLower.tickIdx),
        new BigNumber(position.tickUpper.tickIdx),
        currentTick,
      );
      const adjustedAmount0 = amount0.div(new BigNumber(10).pow(position.token0.decimals));
      const adjustedAmount1 = amount1.div(new BigNumber(10).pow(position.token1.decimals));
      poolsCurrentTvl[pool.id] = poolsCurrentTvl[pool.id].plus(adjustedAmount0).plus(adjustedAmount1.times(new BigNumber(pool.token0Price)));
    }
  }

  data = data.map((p) => {
    const aprDataForPool = aprData[p.id];
    const apr = aprDataForPool ? new BigNumber(aprDataForPool.lastApr) : new BigNumber(0);
    const apy = (Math.pow(1 + apr.dividedBy(365).toNumber(), 365) - 1) * 100;
    console.log("POOL", p.id)
    console.log("apr", apr.isNaN() ? 0 : apr.toNumber())
    console.log("apy", isNaN(apy) ? 0 : apy)



    return {
      pool: p.id,
      chain: utils.formatChain(chainString),
      project: 'stellaswap-v3',
      symbol: `${p.token0.symbol}-${p.token1.symbol}`,
      tvlUsd: parseFloat(p.totalValueLockedUSD),
      apyBase: isNaN(apy) ? 0 : apy,
      // apr: apr.isNaN() ? 0 : apr.toNumber(),
      underlyingTokens: [p.token0.id, p.token1.id],
      url: `https://app.stellaswap.com/pulsar/add/${p.token0.id}/${p.token1.id}`,
    };
  });

  // Filter out pools with invalid or missing fields
  data = data.filter(p => p.pool && p.chain && p.project && p.symbol && p.underlyingTokens.length && p.url);
  
  // console.log("DATA: ", data);
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
