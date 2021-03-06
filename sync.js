/**
 * @description Sync the smartcontract with the SQL. The sync.js is the starting point of it.
 * 
 * @author Medet Ahmetson <admin@blocklords.io>
 * 
 * Following environment variables are required for any *-sync script:
 * @requires REMOTE_HTTP              - the URL endpoint of the blockchain node. i.e. For ethereum use the https://infura.io
 * @requires TRUST_PAD_ADDRESS         - the smartcontract address on the blockchain that is already deployed.
 * @requires CHAIN_GUARDIAN_ADDRESS         - the smartcontract address on the blockchain that is already deployed.
 * @requires PRIVATE_SALE_ADDRESS         - the smartcontract address on the blockchain that is already deployed.
 * @requires TRUST_PAD_DURATION
 * @requires CHAIN_GUARDIAN_DURATION
 * @requires PRIVATE_SALE_DURATION
 * 
 * Following additional json files are required:
 * @requires vesting.json     - the ABI of the smartcontract
 */
require('dotenv').config()

/// Importing third party modules
const fs          = require('fs');                // to fetch the abi of smartcontract

/// Importing other modules:
///   blockchain module - to interact with the blockchain
///   logger module     - to write the data from blockchain to the database
///   database module - to interact with the database
const blockchain    = require('./blockchain');
const { logSync }   = require('./logger');

/// Create the smartcontract instace using the ABI json and the Smartcontract address
const ABI = JSON.parse(fs.readFileSync('./vesting.json', 'utf-8'));

// Initiation of web3 and contract
let web3          = blockchain.reInit();
let privateSale   = blockchain.loadContract(web3, process.env.PRIVATE_SALE_ADDRESS, ABI);
let chainGuardian = blockchain.loadContract(web3, process.env.CHAIN_GUARDIAN_ADDRESS, ABI);
let trustPad      = blockchain.loadContract(web3, process.env.TRUST_PAD_ADDRESS, ABI);

/// Global variables

/**
 * @description This function reads the conf to get the latest updated block height.
 * And then syncs the database until the block height.
 * 
 * We are restarting this script in three cases:
 * - Failed to get the events from blockchain. (Most likely blockchain RPC is dead)
 * - Loading up the Configuration. (Most likely code bug)
 * - Updating the data on File system and Database. (Most likely resources are busy)
 */
 const SyncByUpdate = async () => {
  /// Getting configuration
  let conf = await loadConf();

  while (true) {
    let {latestBlockNum, syncedBlockHeight} = await blockHeights(conf);
    if (isNaN(parseInt(latestBlockNum))) {
      console.log("Failed to connect to web3.");
      web3 = blockchain.reInit();
      await timeOut(conf['sleepInterval']);
      continue;
    }

    /// "from" can't be greater than "to"
    if (syncedBlockHeight > latestBlockNum) {
      console.log(`${currentTime()}: ${syncedBlockHeight} > ${latestBlockNum}`);

      // Set to the latest block number from the blockchain.
      conf['syncedBlockHeight'] = latestBlockNum;
      await saveConf(conf);
    }
  
    if (syncedBlockHeight < latestBlockNum) {
      console.log(`${currentTime()}: ${syncedBlockHeight} < ${latestBlockNum}`);
      await log(conf, latestBlockNum, syncedBlockHeight);
    }

    console.log(`${currentTime()}: ${latestBlockNum} is synced`);

    /// if "from" and "to" are matching, database synced up to latest block. 
    /// Wait for appearance of a new block
    await timeOut(conf['sleepInterval']);
  }
};

/**
 * @description Return the latest local updated block height and blockchain latest block.
 * 
 * We use a separated function, to catch the errors. And throw error in standard way as Sync.js accepts.
 */
let blockHeights = async function(conf) {
  let latestBlockNum;
  let syncedBlockHeight;

  /// "from" blokc height
  syncedBlockHeight = conf['syncedBlockHeight'];
  if (isNaN(syncedBlockHeight)) {
    throw new Error('syncedBlockHeight must be integer')
  }

  /// "to" block height
  try {
    latestBlockNum = await web3.eth.getBlockNumber();
  } catch (error) {
    return {undefined, syncedBlockHeight};
  }

  return {latestBlockNum, syncedBlockHeight};
};

/**
 * @description Fetch the event logs from Blockchain, then write them in the database.
 * @param {Database connection} db 
 * @param {JSON configuration} conf 
 * @returns 
 */
let log = async function(conf, latestBlockNum, syncedBlockHeight) {
    /// Some blockchains sets the limit to the range of blocks when fetching the logs.
    /// In order to avoid it, we are iterating that range through the loop by limited range blocks.
    /// The limited range block is called offset in our script.

    let from, to;
    const offset = conf['offset'];
    const iterationCount = Math.max(0, (latestBlockNum - syncedBlockHeight) / offset);

    from = syncedBlockHeight;
    if ((latestBlockNum - syncedBlockHeight) > offset) {
      to = offset + syncedBlockHeight;
    } else {
      to = latestBlockNum;
    }

    for (let i = 0; i < iterationCount; i++) {
      let privateSaleEvents;
      let chainGuardianEvents;
      let trustPadEvents;

      /// Fetch events for Private Sale
      try {
        privateSaleEvents = await privateSale.getPastEvents('allEvents', {
          fromBlock: from,
          toBlock: to
        });
      } catch (error) {
        console.log(`${currentTime()}: event error:`);
        console.log(error.toString());
        await timeOut(conf['sleepInterval']);
        process.exit(0);
        // Maybe to reinit the Web3?
      }
      
      /// Exit from the script, to restart it by docker, if failed to log the events into the blockchain
      if (privateSaleEvents.length > 0) {
        try {
          await logSync("private-sale", privateSaleEvents, web3, process.env.PRIVATE_SALE_DURATION);
        } catch (error) {
          console.error(`${currentTime()}: log error to database...`);
          console.error(error);
          process.exit()
        }
      }

      // To decrease pressure on Node, wait for 1 second.
      await timeOut(1);

      /// Fetch events for Chain Guardian
      try {
        chainGuardianEvents = await chainGuardian.getPastEvents('allEvents', {
          fromBlock: from,
          toBlock: to
        });
      } catch (error) {
        console.log(`${currentTime()}: event error:`);
        console.log(error.toString());
        await timeOut(conf['sleepInterval']);
        process.exit(0);
        // Maybe to reinit the Web3?
      }
      
      /// Exit from the script, to restart it by docker, if failed to log the events into the blockchain
      if (chainGuardianEvents.length > 0) {
        try {
          await logSync("chain-guardian", chainGuardianEvents, web3, process.env.CHAIN_GUARDIAN_DURATION);
        } catch (error) {
          console.error(`${currentTime()}: log error to database...`);
          console.error(error);
          process.exit()
        }
      }

      // To decrease pressure on Node, wait for 1 second.
      await timeOut(1);

      /// Fetch events for Trust Pad
      try {
        trustPadEvents = await trustPad.getPastEvents('allEvents', {
          fromBlock: from,
          toBlock: to
        });
      } catch (error) {
        console.log(`${currentTime()}: event error:`);
        console.log(error.toString());
        await timeOut(conf['sleepInterval']);
        process.exit(0);
        // Maybe to reinit the Web3?
      }
      
      /// Exit from the script, to restart it by docker, if failed to log the events into the blockchain
      if (trustPadEvents.length > 0) {
        try {
          await logSync("trust-pad", trustPadEvents, web3, process.env.TRUST_PAD_DURATION);
        } catch (error) {
          console.error(`${currentTime()}: log error to database...`);
          console.error(error);
          process.exit()
        }
      }

      from += offset;
      to = (from + offset > latestBlockNum) ? latestBlockNum : from + offset;

      conf['syncedBlockHeight'] = to;
      await saveConf(conf);
    }
};

let loadConf = async function() {
  try {
    return JSON.parse(fs.readFileSync('./public/conf.json', 'utf-8'));
  } catch (error) {
    throw new Error(`Can not read public/conf.json`);
  }
}

let saveConf = async function(conf) {
  try {
    fs.writeFileSync('./public/conf.json', JSON.stringify(conf));
  } catch (error) {
    console.error(error);
    process.exit()
  }
}

/**
 * @description Sleeps the code for few seconds
 * @param {Integer} seconds interval to wait before waiting
 * @returns 
 */
const timeOut = async function(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const currentTime = function() {
  let currentdate = new Date();
  return `${currentdate.getDate()}/${(currentdate.getMonth()+1)}/${currentdate.getFullYear()} ${currentdate.getHours()}:${currentdate.getMinutes()}:${currentdate.getSeconds()}`;
};

module.exports.SyncByUpdate = SyncByUpdate;

// In case if you want to call it from here.
// SyncByUpdate().then(() => {
//   process.exit(1);
// })
// .catch(error => {
//   console.log(error);
//   process.exit(error);
// });