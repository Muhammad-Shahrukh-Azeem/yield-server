const { request, gql } = require('graphql-request');
const sdk = require('@defillama/sdk');
const axios = require('axios');

const utils = require('../utils');

const urlMoonbeam = 'https://api.studio.thegraph.com/proxy/78672/pulsar/v0.0.1/';

const queryPools = gql`
  {
    pools(first: 1000 orderBy: totalValueLockedUSD orderDirection: desc) {
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
    }
  }
`;

const queryPrior = gql`
  {
    pools(first: 1000 orderBy: totalValueLockedUSD orderDirection: desc) {
      id
      volumeUSD
      feesToken0
      feesToken1
      token0Price
      token1Price
    }
  }
`;

const topLvl = async (chainString, timestamp, url) => {
  const [block, blockPrior] = await utils.getBlocks(chainString, timestamp, [url]);
  const [_, blockPrior7d] = await utils.getBlocks(chainString, timestamp, [url], 604800);

  let data = (await request(url, queryPools)).pools;

  // Fetch 24h offset data for volume calculations
  const dataPrior = (await request(url, queryPrior)).pools;
  // Fetch 7d offset data for volume calculations
  const dataPrior7d = (await request(url, queryPrior)).pools;

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

  data = data.map((p) => {
    // Calculate fees in token0
    const currentFeesInToken0 = parseFloat(p.feesToken0) + (parseFloat(p.feesToken1) * parseFloat(p.token0Price));
    const priorData = dataPrior.find(dp => dp.id === p.id);
    const priorFeesInToken0 = priorData ? (parseFloat(priorData.feesToken0) + (parseFloat(priorData.feesToken1) * parseFloat(priorData.token0Price))) : 0;
    const feesIn24Hours = currentFeesInToken0 - priorFeesInToken0;

    console.log("Fees calculation for pool", p.id, currentFeesInToken0, priorFeesInToken0, feesIn24Hours);


    // Calculate APR and APY
    const apr = (feesIn24Hours * 365 * 100) / parseFloat(p.totalValueLockedUSD);
    const apy = (Math.pow(1 + apr / 365, 365) - 1) * 100;

    return {
      pool: p.id,
      chain: utils.formatChain(chainString),
      project: 'stellaswap-v3',
      symbol: `${p.token0.symbol}-${p.token1.symbol}`,
      tvlUsd: parseFloat(p.totalValueLockedUSD),
      apyBase: isNaN(apy) ? 0 : apy,
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
