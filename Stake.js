
const TOKEN_PRECISION = 6;
const ROUND_DOWN = 1;
const IOST_TOKEN = 'iost';
const IOST_DECIMAL = 8;

const PAD_PRECISION = 6;
const UNIVERSAL_PRECISION = 12;
const MAP_PRODUCER_COEF = "pc";
const PAIR_LOCK_DAYS = 0;

const STAKE_TEAMFEE = 0.1;

const TIME_LOCK_DURATION = 12 * 3600; // 12 hours
const DAILY_TOKEN_PERCENTAGE = 0.03;

// APY = (1 + 0.03/4)**4 – 1
// dailyTokenDistribution =  (totalSupply * .03) / 365
// tr = dailyTokenDistribution * days from last claimed 
// rewards = tr  * ( staked_token / staked_total)

class Stake {

  init() {
    this._createToken();
    this._createIOSTPools();
  }

  can_update(data) {
    return blockchain.requireAuth(blockchain.contractOwner(), "active") && !this.isLocked();
  }

  _requireOwner() {
    if(!blockchain.requireAuth(blockchain.contractOwner(), 'active')){
      throw 'require auth error:not contractOwner';
    }
  }

  setSwap(contractID){
    if(contractID.length != 52 || contractID.indexOf("Contract") != 0){
      throw "Invalid contract ID."
    }

    storage.put('swap', contractID, tx.publisher)
  }

  _getSwap(){
    var contractID = storage.get('swap');

    if(contractID.length != 52 || contractID.indexOf("Contract") != 0){
      throw "Invalid contract ID."
    }
    return contractID;
  }

  addPooltoVault(token0, token1, alloc, minStake){

    this._requireOwner()

    const pair = JSON.parse(blockchain.callWithAuth(this._getSwap(), "getPair", [token0, token1])[0]);

    if(pair === null || pair === undefined){
      throw "Invalid pair"
    }

    let pairName = pair.token0 + "/" + pair.token1;

    //token, alloc, minStake, willUpdate
    alloc = +alloc || 0;

    if (this._hasPair(pairName)) {
      throw "Pair vault exists";
    }

    this._addPair(pairName);

    this._applyDeltaToTotalAlloc(alloc);

    storage.mapPut("pair", pairName, JSON.stringify({
      total: "0",
      tokenPrecision: this._checkPrecision(this._getTokenName()),
      alloc: alloc,
      lastRewardTime: 0,
      accPerShare: "0",
      accPerShareExtra: "0",
      min: minStake,
      pairLP: pair.lp,
      tokenReward: this._getTokenName(),
      apy: this._getAPY(this._getPoolAllocPercentage(pairName))
    }), 
    tx.publisher);
  }

  _addLog(transaction, token, amount){
    const key = token + ":" + tx.publisher;
    var transLog = this._mapGet("stakingLog", key, [])
    const now = Math.floor(tx.time / 1e9); 
    
    transLog.push({
      "transaction": transaction, 
      "value": amount,
      "token": token, 
      "timestamp": now,
      "hash": tx.hash
    })
    
    this._mapPut("stakingLog", key, transLog, tx.publisher)
  }

  _mapGet(k, f, d) {
    const val = storage.mapGet(k, f);
    if (val === null || val === "") {
        return d;
    }
    return JSON.parse(val);
  }

  _mapPut(k, f, v, p) {
    storage.mapPut(k, f, JSON.stringify(v), p);
  }

  _mapDel(k, f) {
    storage.mapDel(k, f);
  }

  _globalMapGet(c, k, f, d) {
    const val = storage.globalMapGet(c, k, f);
    if (val === null || val === "") {
      return d;
    }
    return JSON.parse(val);
  }

  _getTokenName(){
    return storage.get('token') || '';
  }

  _getTokenList(){
    return JSON.parse(storage.get('tokenList') || '[]');
  }

  _getPairList(){
    return JSON.parse(storage.get('pairList') || '[]');
  }

  _getProducerName(){
    return storage.get('producer') || 'metanyx';
  }

  _compound(r, n=365, t=1, c=1) {
    return (1 + (r * c) / n) ** (n * t) - 1;
  }

  setProducerName(name){
    if (!storage.globalMapHas("vote_producer.iost", "producerTable", name)) {
      throw "Producer does not exist";
    }
    storage.put("producer", name, tx.publisher)
  }

  _setTokenName(token){
    storage.put("token", token.toString(), tx.publisher);

    // create token list
    let data = [ token + "_3", token + "_30", token + "_90"];
    let alloc = ["3", "5", "10"]
    storage.put("tokenList", JSON.stringify(data), tx.publisher);

    // add pools
    for (var i = data.length - 1; i >= 0; i--) {
      this.addPool(data[i], alloc[i], "1", "False")
    }
  }

  _modifyMapAmount(key, field, adjustment) {
    let value = new Float64(this._mapGet(key, field, "0"));

    value = value.plus(adjustment);

    this._mapPut(key, field, value, tx.publisher);

    return value;
  }

  _createIOSTPools(){
    this._requireOwner()

    const token = 'iost'
    let data = [ token + "_0", token + "_3", token + "_30", token + "_90"];
    let alloc = ["1", "2", "3", "5"] 

    for (var i = data.length - 1; i >= 0; i--) {
      if(!this._hasPool(data[i])){
        this.addPool(data[i], alloc[i], "1", "False")  
      }
    }

  }

  _sendToDeadAddr(token, amount){
    let destroyAmount = amount;
    if (destroyAmount.toFixed(2) !== "0.00") {
        blockchain.callWithAuth("token.iost", "transfer", [token, blockchain.contractName(), "deadaddr", destroyAmount.toFixed(2), ""]);
    }
  }

  isLocked() {
    const now = Math.floor(tx.time / 1e9);
    const status = +storage.get("timeLockStatus") || 0;
    const until = +storage.get("timeLockUntil") || 0;
    return status == 1 || now < until;
  }

  startTimeLock() {
    this._requireOwner();

    storage.put("timeLockStatus", "1", tx.publisher);
  }

  stopTimeLock() {
    this._requireOwner();

    const now = Math.floor(tx.time / 1e9);

    storage.put("timeLockUntil", (now + TIME_LOCK_DURATION).toString(), tx.publisher);
    storage.put("timeLockStatus", "0", tx.publisher)
  }

  _createToken(token) {
    this._requireOwner()

    if (!blockchain.requireAuth(blockchain.contractOwner(), "active")) {
      throw "only owner can change";
    }

    const config = {
      "decimal": 6,
      "canTransfer": true,
      "fullName": "HyperDefi Token"
    };

    blockchain.callWithAuth("token.iost", "create",
        [token, blockchain.contractName(), 1000000, config]);

    this._setTokenName(token);
  }

  _getExtra() {
    return storage.get("extra") || '';
  }

  _getToday() {
    return Math.floor(tx.time / 1e9 / 3600 / 24);
  }

  _lock(who, token, amount, precision) {
    const map = JSON.parse(storage.mapGet("lockMap", who) || "{}");
    if (!map[token]) {
      map[token] = [];
    }

    const today = this._getToday();
    const last = map[token][map[token].length - 1];

    if (last && last[0] == today) {
      last[1] = new BigNumber(last[1]).plus(amount).toFixed(precision, ROUND_DOWN);
    } else {
      map[token].push([today, new BigNumber(amount).toFixed(precision, ROUND_DOWN)]);
    }

    storage.mapPut("lockMap", who, JSON.stringify(map), tx.publisher);
  }

  _unlockInternal(who, token, amount, precision, today, days, willSave) {

    const map = JSON.parse(storage.mapGet("lockMap", who) || "{}");
    if (!map[token]) {
      map[token] = [];
    }

    var remain = new BigNumber(amount);
    if(days == 0){
      return new BigNumber(amount).toFixed(precision, ROUND_DOWN);
    }

    while (map[token].length > 0 && remain.gt(0)) {
      const head = map[token][0];

      if (today < head[0] + days) {
        break;
      }

      if (remain.gte(head[1])) {
        remain = remain.minus(head[1]);
        map[token].shift();
      } else {
        head[1] = new BigNumber(head[1]).minus(remain).toFixed(precision, ROUND_DOWN);
        remain = new BigNumber(0);
        break;
      }
    }

    if (willSave) {
      storage.mapPut("lockMap", who, JSON.stringify(map), tx.publisher);
    }
    // The actually withdraw amount.
    return new BigNumber(amount).minus(remain).toFixed(precision, ROUND_DOWN);
  }

  _unlock(who, token, amount, precision, days) {
    const today = this._getToday();
    return this._unlockInternal(who, token, amount, precision, today, days, true);
  }

  _getUserInfo(who) {
    return JSON.parse(storage.mapGet("userInfo", who) || "{}");
  }

  getUserTokenAmount(who, tokenList) {
    tokenList = JSON.parse(tokenList);

    var total = new BigNumber(0);
    tokenList.forEach(token => {
      if (this._getUserInfo(who)[token]) {
        total = total.plus(this._getUserInfo(who)[token].amount);
      }
    });

    return total.toFixed(6);
  }

  _setUserInfo(who, info) {
    storage.mapPut("userInfo", who, JSON.stringify(info), tx.publisher);
  }

  _getTokenArray() {
    return JSON.parse(storage.get("tokenArray") || "[]");
  }

  _setUserToken(who, token) {
    storage.mapPut("userToken", who, token, tx.publisher);
  }

  _getUserToken(who) {
    return storage.mapGet("userToken", who) || "";
  }

  _voteProducer(amount) {
    blockchain.callWithAuth("vote_producer.iost", "vote", [
      blockchain.contractName(),
      this._getProducerName(),
      amount.toString()
    ]);
  }

  _unvoteProducer(amount) {
    blockchain.callWithAuth("vote_producer.iost", "unvote", [
      blockchain.contractName(),
      this._getProducerName(),
      amount.toString()
    ]);
  }

  _getVote(token) {
    return storage.mapGet("vote", token) || "0";
  }

  _setVote(token, amountStr) {
    storage.mapPut("vote", token, amountStr, tx.publisher);
  }

  _addVote(token, amountStr) {
    const currentStr = this._getVote(token);
    this._setVote(token, new BigNumber(currentStr).plus(amountStr).toFixed(UNIVERSAL_PRECISION));
  }

  _minusVote(token, amountStr) {
    const currentStr = this._getVote(token);
    this._setVote(token, new BigNumber(currentStr).minus(amountStr).toFixed(UNIVERSAL_PRECISION));
  }

  _getTotalVote() {
    return storage.get("totalVote") || "0";
  }

  _setTotalVote(amountStr) {
    storage.put("totalVote", amountStr, tx.publisher);
  }

  _addTotalVote(amountStr) {
    const currentStr = this._getTotalVote();
    this._setTotalVote(new BigNumber(currentStr).plus(amountStr).toFixed(UNIVERSAL_PRECISION));
  }

  _minusTotalVote(amountStr) {
    const currentStr = this._getTotalVote();
    this._setTotalVote(new BigNumber(currentStr).minus(amountStr).toFixed(UNIVERSAL_PRECISION));
  }

  _addToken(token) {
    const tokenArray = this._getTokenArray();

    if (tokenArray.indexOf(token) < 0) {
      tokenArray.push(token);
    }

    storage.put("tokenArray", JSON.stringify(tokenArray), tx.publisher);

  }

  _addPair(pair){
    this._addToken(pair)

    const pairList = this._getPairList();

    if (pairList.indexOf(pair) < 0) {
      pairList.push(pair);
    }

    storage.put("pairList", JSON.stringify(pairList), tx.publisher);
  }

  _addToTokenList(token) {
    this._addToken(token)

    const tokenList = this._getTokenList();

    if (tokenList.indexOf(token) < 0) {
      tokenList.push(token);
    }

    storage.put("tokenList", JSON.stringify(tokenList), tx.publisher);
  }

  _addUserBalanceList(user) {
    const userBalanceList = JSON.parse(storage.get("userBalanceList") || "[]");

    if (userBalanceList.indexOf(user) < 0) {
      userBalanceList.push(user);
    }

    storage.put("userBalanceList", JSON.stringify(userBalanceList), tx.publisher);
  }

  _getTotalAlloc() {
    return +storage.get("totalAlloc") || 0;
  }

  _applyDeltaToTotalAlloc(delta) {
    var totalAlloc = this._getTotalAlloc();
    totalAlloc = (totalAlloc + delta).toFixed(1);

    if (totalAlloc < 0) {
      throw "negative total alloc";
    }

    storage.put("totalAlloc", totalAlloc.toString(), tx.publisher);
  }

  _hasPool(token) {
    return storage.mapHas("pool", token);
  }

  _hasPair(token) {
    return storage.mapHas("pair", token);
  }

  _getPool(token) {
    return JSON.parse(storage.mapGet("pool", token) || "{}");
  }

  _getPair(token) {
    return JSON.parse(storage.mapGet("pair", token) || "{}");
  }

  getPool(token) {
    return this._getPool(token);
  }

  _checkPrecision(symbol) {
    return +storage.globalMapGet("token.iost", "TI" + symbol, "decimal") || 0;
  }

  _setBalance(balanceStr) {
    storage.put("balance", balanceStr.toString(), tx.publisher);
  }

  _getBalance() {
    return new BigNumber(storage.get("balance") || "0");
  }

  _setQueue(queue) {
    storage.put("queue", JSON.stringify(queue), tx.publisher);
  }

  _getQueue() {
    return JSON.parse(storage.get("queue") || "[]");
  }

  _setLastTime(lastTime) {
    storage.put("lastTime", JSON.stringify(lastTime), tx.publisher);
  }

  _getLastTime() {
    return JSON.parse(storage.get("lastTime") || "0");
  }

  addPool(token, alloc, minStake, willUpdate) {
    this._requireOwner()

    var symbol;
    if (this._getTokenList().indexOf(token) >= 0) {
      symbol = this._getTokenName();
    } else {
      symbol = token;
    }

    alloc = +alloc || 0;
    willUpdate = +willUpdate || 0;

    if (this._hasPool(token)) {
      throw "pool exists";
    }

    if (willUpdate) {
      this.updateAllPools();
    }

    this._addToTokenList(token);

    this._applyDeltaToTotalAlloc(alloc);

    storage.mapPut("pool", token, JSON.stringify({
      total: "0",
      tokenPrecision: this._checkPrecision(symbol),
      alloc: alloc,
      lastRewardTime: 0,
      accPerShare: "0",
      accPerShareExtra: "0",
      min: minStake,
      apy:"0",
    }), 
    tx.publisher);
  }

  _getAPY(poolPercentage){
    const supplyTotal = new BigNumber(blockchain.call("token.iost", "totalSupply", [this._getTokenName()]));
    const supply = new BigNumber(blockchain.call("token.iost", "supply", [this._getTokenName()]));
    const yearlyDistribution = supplyTotal.minus(supply).times(DAILY_TOKEN_PERCENTAGE)

    var yearlyRewards = yearlyDistribution.times(poolPercentage);
    var simpleApy = yearlyRewards.div(supply)

    return this._compound(simpleApy, 2190, 1, 0.96) * 100;
  }

  _getPoolAllocPercentage(token){
    var pool = this._getPool(token)
    if(JSON.stringify(pool) == '{}'){
      pool = this._getPair(token)
    }
    const totalAlloc = this._getTotalAlloc();

    return new BigNumber(pool.alloc).div(totalAlloc)
  }

  _setPoolObj(key, token, pool) {
    if(["pair", "pool"].indexOf(key) < 0){
      throw "Invalid key."
    }
    storage.mapPut(key, token, JSON.stringify(pool), tx.publisher);
  }

  _getDays(fromTime, toTime) {
    if(toTime < fromTime){
      return 0;
    }
    return new BigNumber(toTime - fromTime).div(3600 * 24);
  }

  _takeExtra(token) {
    if (token != "iost") {
      throw "Only iost is supported";
    }

    const queue = this._getQueue();
    const lastTime = this._getLastTime();
    const now = Math.floor(tx.time / 1e9);

    var amountToSend = new BigNumber(0);

    for (let i = 0; i < queue.length; ++i) {
      const time = Math.min(now, queue[i].startTime + 3600 * 24);
      const lastTimeI = Math.max(lastTime, queue[i].startTime);
      const amount = new BigNumber(queue[i].delta).times(
          time - lastTimeI).div(3600 * 24);
      amountToSend = amountToSend.plus(amount);
    }

    const oldBalance = this._getBalance();
    const newBalance = new BigNumber(blockchain.call("token.iost", "balanceOf", ["iost", blockchain.contractName()])[0]);

    // Queue in
    if (newBalance.minus(oldBalance).gte(MINIMUM_IOST_UNIT)) {
      // Every time the iost balance goes up, it will be distributed in the next
      // 24 hours evenly.
      const delta = newBalance.minus(oldBalance);
      queue.push({
        startTime: now,
        delta: delta.toFixed(IOST_PRECISION, ROUND_DOWN)
      });
      this._setBalance(newBalance.toFixed(IOST_PRECISION, ROUND_DOWN));
    }

    // Queue out
    if (queue[0] && lastTime >= queue[0].startTime + 24 * 3600) {
      queue.shift();
    }

    this._setQueue(queue);

    // amountToSend should be less than current balance in case
    // there is calculator error due to rounding.
    if (amountToSend.gt(newBalance)) {
      amountToSend = newBalance;
    }

    if (amountToSend.lt(MINIMUM_IOST_UNIT)) {
      return "0";
    }

    this._setLastTime(now);
    const amountToSendStr = amountToSend.toFixed(IOST_PRECISION, ROUND_DOWN);

    // Update iost balance before we go.
    this._setBalance(blockchain.call("token.iost", "balanceOf", ["iost", blockchain.contractName()])[0]);
    return amountToSendStr;
  }

  _getReward(multiplier){
    // get token total 
    const supplyTotal = new BigNumber(blockchain.call("token.iost", "totalSupply", [this._getTokenName()]));
    const supply = new BigNumber(blockchain.call("token.iost", "supply", [this._getTokenName()]));
    const dailyDistribution = supplyTotal.minus(supply).times(DAILY_TOKEN_PERCENTAGE).div(365).times(multiplier)
    const userInfo = this._getUserInfo(tx.publisher);
    const pool = this._getPool(this._getTokenName());
    let amount = new BigNumber(userInfo[this._getTokenName()].amount);
    return amount.div(pool.total).times(dailyDistribution);

  }

  _addUserVote(token, amount){
    let userVotes = this._mapGet('userInfo', tx.publisher, {})

    if(userVotes[token] !== undefined ){
      let votes = new BigNumber(userVotes[token]['voteAmount'] || '0')
      userVotes[token]['voteAmount'] = votes.plus(amount);
    }else{
      let votes = new BigNumber('0');
      userVotes[token] = {
        amount: "0",
        rewardPending: "0",
        rewardDebt: "0",
        networkRewardPending: "0",
        voteAmount: votes.plus(amount),
        withdrawable: "0",
      };
    }
    this._mapPut('userInfo', tx.publisher, userVotes, tx.publisher)
  }

  _removeUserVote(token){
    let userVotes = this._mapGet('userInfo', tx.publisher, {})
    if(userVotes[token]){
      userVotes[token]['voteAmount'] = 0;
      this._mapPut('userInfo', tx.publisher, userVotes, tx.publisher)
    }
  }

  _updatePool(token, pool) {
    const now = Math.floor(tx.time / 1e9);
    const userInfo = this._getUserInfo(tx.publisher);

    var userToken = token.split('_')[0];
    var type;
    if(this._hasPair(token)){
      type = 'pair';
    }else{
      type = 'pool'
    }

    if (now <= pool.lastRewardTime) {
      return;
    }

    const total = new BigNumber(pool.total);

    if (total.eq(0)) {
      pool.lastRewardTime = now;
      this._setPoolObj(type, token, pool);
      return;
    }

    // 1) Process token
    const days = this._getDays(pool.lastRewardTime, now);
    const totalAlloc = this._getTotalAlloc();
    const reward = new BigNumber(days).times(pool.alloc).div(totalAlloc);
    //const reward = this.reward(multiplier);

    if (reward.gt(0)) {
      const rewardForFarmers = reward.times(0.9);
      const rewardForDev = reward.times(0.1);

      // Mint token.
      blockchain.callWithAuth("token.iost", "issue",
        [this._getTokenName(), blockchain.contractName(), rewardForFarmers.toFixed(TOKEN_PRECISION, ROUND_DOWN)]);
      blockchain.callWithAuth("token.iost", "issue",
        [this._getTokenName(), blockchain.contractOwner(), rewardForDev.toFixed(TOKEN_PRECISION, ROUND_DOWN)]);

      // PAD_PRECISION here to make sure we have enough precision per share.
      pool.accPerShare = new BigNumber(pool.accPerShare).plus(rewardForFarmers.div(total)).toFixed(TOKEN_PRECISION + PAD_PRECISION, ROUND_DOWN);
    }

    // 3) Done.
    pool.lastRewardTime = now;
    pool.apy = this._getAPY(this._getPoolAllocPercentage(token))
    this._setPoolObj(type, token, pool);
  }

  updateAllPools() {
    const tokenArray = this._getTokenArray();
    tokenArray.forEach(token => {
      this.updatePool(token);
    });
  }

  _getTokenRewardPending(who, token, dailyDistribution) {
    const now = Math.floor(tx.time / 1e9); 
    let userToken;

    if (!this._hasPool(token) && !this._hasPair(token)) {
      throw "NO_POOL_FOR_TOKEN";
    }

    var pool;
    if(this._hasPool(token)){
      pool = this._getPool(token);  
    }else if(this._hasPair(token)){
      pool = this._getPair(token);  
    }
    
    const userInfo = this._getUserInfo(who);

    if (!userInfo[token]) {
      userInfo[token] = {
        amount: "0",
        rewardPending: "0",
        rewardDebt: "0"
      }

      return "0";
    }

    var accPerShare = new BigNumber(pool.accPerShare);
    const total = new BigNumber(pool.total);

    if (now > pool.lastRewardTime && total.gt(0)) {
      let days = this._getDays(pool.lastRewardTime, now);
      const totalAlloc = this._getTotalAlloc();
      const reward = new BigNumber(days).times(pool.alloc).div(totalAlloc);
      //const reward = this._getReward(multiplier);
      //const reward = new BigNumber(multiplier).times(pool.alloc).div(totalAlloc);
      accPerShare = accPerShare.plus(reward.div(total));

      if(days > 1){
        // need to limit to dailyrewards rate
        days = 1;
      }

      let tokenRewards = accPerShare.times(
        userInfo[token].amount).times(
        dailyDistribution).times(
        days).toFixed(TOKEN_PRECISION, ROUND_DOWN)
      return tokenRewards;
    }

    return "0";
    
  }

  _deposit(token, amount) {
    if (!this._hasPool(token) && !this._hasPair(token)) {
      throw "NO_POOL_FOR_TOKEN";
    }

    var pool;
    var type;
    if(this._hasPool(token)){
      pool = this._getPool(token);
      type = 'pool';
    }else if(this._hasPair(token)){
      pool = this._getPair(token);
      type = 'pair'
    }

    if(pool === undefined){
      throw "Invalid token"
    }
    

    if(amount < pool.min){
      throw "Amount is less than the minimum stake value";
    }

    amount = new BigNumber(amount);
    const amountStr = amount.toFixed(pool.tokenPrecision, ROUND_DOWN);

    if (amount.lte(0)) {
      throw "Amount is less than zero.";
    }

    const userInfo = this._getUserInfo(tx.publisher);

    if (!userInfo[token]) {
      userInfo[token] = {
        amount: "0",
        rewardPending: "0",
        rewardDebt: "0",
        networkRewardPending: "0",
        voteAmount: "0",
        withdrawable: "0",
        lastRewardTime: "0",
      }
    }

    this._updatePool(token, pool);
    var userAmount = new BigNumber(userInfo[token].amount);

    if (userAmount.gt(0)) {
      userInfo[token].rewardPending = userAmount.times(pool.accPerShare).minus(userInfo[token].rewardDebt).plus(userInfo[token].rewardPending).toFixed(TOKEN_PRECISION, ROUND_DOWN);
    }

    if (this._getTokenList().indexOf(token) >= 0) {
      blockchain.callWithAuth("token.iost", "transfer",
          [this._getTokenName(),
           tx.publisher,
           blockchain.contractName(),
           amountStr,
           "deposit"]);

      this._lock(tx.publisher, token, amountStr, TOKEN_PRECISION);
    } else if(this._getPairList().indexOf(token) >= 0){
      // deposit lp token
      blockchain.callWithAuth("token.iost", "transfer",
          [pool.pairLP,
           tx.publisher,
           blockchain.contractName(),
           amountStr,
           "deposit"]);
      this._lock(tx.publisher, token, amountStr, TOKEN_PRECISION);
    }else if(token.indexOf(IOST_TOKEN) >= 0 && type == 'pool'){
      blockchain.callWithAuth("token.iost", "transfer",
          ['iost',
           tx.publisher,
           blockchain.contractName(),
           amountStr,
           "deposit"]);
      this._lock(tx.publisher, token, amountStr, TOKEN_PRECISION);
    }

    userAmount = userAmount.plus(amountStr);
    userInfo[token].amount = userAmount.toFixed(pool.tokenPrecision, ROUND_DOWN);
    userInfo[token].rewardDebt = userAmount.times(pool.accPerShare).toFixed(TOKEN_PRECISION, ROUND_DOWN);
    this._setUserInfo(tx.publisher, userInfo);
    this._addUserBalanceList(tx.publisher);
    pool.total = new BigNumber(pool.total).plus(amount).toFixed(pool.tokenPrecision, ROUND_DOWN);
    this._setPoolObj(type, token, pool);
    blockchain.receipt(JSON.stringify(["deposit", token, amountStr]));
  }

  stake(token, amountStr) {
    if (this._getTokenList().indexOf(token) < 0 && token.indexOf(IOST_TOKEN) < 0 && this._getPairList().indexOf(token) < 0 || token == 'iost') {
      throw "WRONG_TOKEN";
    }

    this._deposit(token, amountStr);
    if(token.indexOf(IOST_TOKEN) >= 0 && this._getPairList().indexOf(token) < 0){
      if(token != 'iost' && token != 'iost_0' && token != 'iost_1'){
        this._voteProducer(amountStr)  
        // add user vote per vault
        this._addUserVote(token, amountStr)
      }
    }
    const userToken = this._getUserToken(tx.publisher);
    if (userToken) {
      this._addVote(userToken, amountStr);
    }
    this._addTotalVote(amountStr);
    this._addLog("stake", token, amountStr)
  }

  _getRealAmountStr(token, userAmountStr, days){
    var realAmount;
    var userToken = token.split('_')[0];

    if(this._getPairList().indexOf(token) >= 0){
      let pool = this._getPair(token)
      userToken = pool.pairLP;
      realAmount = this._unlock(tx.publisher, token, userAmountStr, TOKEN_PRECISION, days);
    }else if (this._getTokenList().indexOf(token) >= 0) {
      userToken = this._getTokenName();
      realAmount = this._unlock(tx.publisher, token, userAmountStr, TOKEN_PRECISION, days);
    } else if(token.indexOf(IOST_TOKEN) > -1){
      realAmount = this._unlock(tx.publisher, token, userAmountStr, TOKEN_PRECISION, days);  
    } else {
      realAmount = userAmountStr; 
    }

    if (new BigNumber(realAmount).lte(0)) {
      throw "No user balance / stake is still lock for token " + token ;
    }

    var realAmountString = realAmount.toString();
    blockchain.callWithAuth("token.iost", "transfer",
      [userToken,
      blockchain.contractName(),
      tx.publisher,
      realAmountString,
      "withdraw2"]); 
    return realAmountString;
  }

  _withdraw(token) {
    if (!this._hasPool(token) && !this._hasPair(token)) {
      throw "NO_POOL_FOR_TOKEN";
    }

    var pool;
    var type;
    if(this._hasPool(token)){
      pool = this._getPool(token);
      type = 'pool';
    }else if(this._hasPair(token)){
      pool = this._getPair(token);
      type = 'pair'
    }

    if(pool === undefined){
      throw "Invalid token"
    }

    const userInfo = this._getUserInfo(tx.publisher);

    if (userInfo[token] === undefined) {
      // Empty pool
      return "0";
    }

    this._updatePool(token, pool);
    const userAmount = new BigNumber(userInfo[token].amount);
    const userAmountStr = userAmount.toFixed(pool.tokenPrecision, ROUND_DOWN);
    const pending = userAmount.times(pool.accPerShare).plus(
        userInfo[token].rewardPending).minus(userInfo[token].rewardDebt);
    const pendingStr = pending.toFixed(TOKEN_PRECISION, ROUND_DOWN);
    
    if (new BigNumber(pendingStr).gt(0)) {
      var tokenName;
      if(pool.pairLP !== undefined){
        tokenName = pool.tokenReward;
      }else{
        tokenName = token.split('_')[0];
      }

      blockchain.callWithAuth("token.iost", "transfer",
        [tokenName,
          blockchain.contractName(),
          tx.publisher,
          pendingStr.toString(),
          "claim pending"]);
      userInfo[token].rewardPending = "0";
    }

    var days;
    if(type == "pair"){
      days = PAIR_LOCK_DAYS;
    }else{
      days = token.split("_")[1] * 1;
    }
    var realAmountStr = this._getRealAmountStr(token, userAmountStr, days);
    const userRemainingAmount = userAmount.minus(realAmountStr);

    if (userRemainingAmount.lt(0)) {
      throw "invalid remaining amount";
    }

    userInfo[token].amount = userRemainingAmount.toFixed(pool.tokenPrecision, ROUND_DOWN);
    userInfo[token].rewardDebt = userRemainingAmount.times(pool.accPerShare).toFixed(TOKEN_PRECISION, ROUND_DOWN);
    this._setUserInfo(tx.publisher, userInfo);

    pool.total = new BigNumber(pool.total).minus(realAmountStr).toFixed(pool.tokenPrecision, ROUND_DOWN);
    this._setPoolObj(type, token, pool);

    blockchain.receipt(JSON.stringify(["withdraw", token, pendingStr, realAmountStr]));
    return realAmountStr;
  }

  unstake(token) {
    if ((this._getTokenList().indexOf(token) < 0) && this._getPairList().indexOf(token) < 0 && (token.indexOf(IOST_TOKEN) < 0)) {
      throw "Token " + token + " is invalid.";
    }

    const amountStr = this._withdraw(token);
    const userToken = this._getUserToken(tx.publisher);

    if(token.indexOf(IOST_TOKEN) > -1 && this._getPairList().indexOf(token) < 0){
      const days = token.split("_")[1] * 1;
      if(token != 'iost' && token != 'iost_0' && token != 'iost_1'){
        this._unvoteProducer(amountStr)
        // subtract user vote per vault
        this._removeUserVote(token)
      }
    }

    if (userToken) {
      this._minusVote(userToken, amountStr);
    }

    this._minusTotalVote(amountStr);
    this._addLog("unstake", token, amountStr)
  }

  _receipt() {
    blockchain.receipt(JSON.stringify(Object.values(arguments)));
  }

  processStakeRewards() {
    this._requireOwner();

    const supplyTotal = new BigNumber(blockchain.call("token.iost", "totalSupply", [this._getTokenName()]));
    const supply = new BigNumber(blockchain.call("token.iost", "supply", [this._getTokenName()]));
    const dailyDistribution = supplyTotal.minus(supply).times(DAILY_TOKEN_PERCENTAGE).div(365);
    const now = Math.floor(tx.time / 1e9)

    let userVotes = JSON.parse(storage.get('userBalanceList') || "[]");
    storage.put('rewardProcessing', '1', tx.publisher)
    let userCount = userVotes.length;
    let pools = this._getTokenArray();
    let totalTokenRewards = new BigNumber(0);

    for (let i = 0; i <= userCount -1; i++) {
      // loop through the vaults
      var authUser = JSON.parse(storage.globalMapGet("auth.iost", "auth", userVotes[i]));
      if(authUser["permissions"]["active"]["items"][0]["id"] != authUser["permissions"]["owner"]["items"][0]["id"]){
        continue;
      }
      for (let p = 0; p <= pools.length -1; p++){
        var pool;
        var type;
        if(this._hasPool(pools[p])){
          pool = this._mapGet('pool', pools[p], {});
          type = 'pool';
        }else if(this._hasPair(pools[p])){
          // try to get the pair
          pool = this._mapGet('pair', pools[p], {});
          type = 'pair';
        }

        if(pools[p].indexOf(IOST_TOKEN) && type == 'pool' && (pools[p] != 'iost' && pools[p] != 'iost_0' && pools[p] != 'iost_1')){
          let producerCoef;
          let producerCoefCache = {};
          let teamFeeIncrease = 0;
          let tradeInIncrease = 0;
          let userVote = this._getUserInfo(userVotes[i]);

          if (!userVote[pools[p]] || userVote[pools[p]] === undefined || userVote[pools[p]]['withdrawable'] > 0) continue;

          if(producerCoefCache.hasOwnProperty(this._getProducerName())){
            producerCoef = producerCoefCache[this._getProducerName()];
          }else{
            producerCoef = new Float64(this._mapGet(MAP_PRODUCER_COEF, this._getProducerName(), 0));
            producerCoefCache[this._getProducerName()] = producerCoef;
          }

          const grossRewards = producerCoef.multi(userVote[pools[p]]['voteAmount'] || 0);
          let teamFee = new Float64(grossRewards.multi(STAKE_TEAMFEE).toFixed(8));
          let netRewards = grossRewards.minus(teamFee)

          userVote[pools[p]]['networkRewardPending'] = new Float64(userVote[pools[p]]['networkRewardPending'] || 0).plus(netRewards).toFixed(8);
          // update token rewards as well 
          let tokenRewards = new BigNumber(this._getTokenRewardPending(userVotes[i], pools[p], dailyDistribution));


          
          totalTokenRewards = totalTokenRewards.plus(tokenRewards)

          tokenRewards.plus(
            userVote[pools[p]].rewardPending).minus(
            userVote[pools[p]].rewardDebt).times(0.96).toFixed(TOKEN_PRECISION, ROUND_DOWN);

          userVote[pools[p]]['rewardPending'] = new Float64(tokenRewards).toFixed(8);

          // this._receipt("" + grossRewards, teamFee, " NR: " + netRewards, " TR: " + tokenRewards);
          this._mapPut('userInfo', userVotes[i], userVote, tx.publisher);

        } else {
          // only update token rewards
          let userVote = this._getUserInfo(userVotes[i]);
          let tokenRewards = new BigNumber(this._getTokenRewardPending(userVotes[i], pools[p], dailyDistribution));
          totalTokenRewards = totalTokenRewards.plus(tokenRewards)

          if(userVote[pools[p]] !== undefined){
            tokenRewards.plus(
              userVote[pools[p]].rewardPending).minus(
              userVote[pools[p]].rewardDebt).times(0.96).toFixed(TOKEN_PRECISION, ROUND_DOWN);

            userVote[pools[p]]['rewardPending'] = new Float64(tokenRewards).toFixed(8);
            // this._receipt("TR: " + tokenRewards);
            this._mapPut('userInfo', userVotes[i], userVote, tx.publisher);   
          }
        }
        pool.lastRewardTime = now;
        this._setPoolObj(type, pools[p], pool);

      }
    }
    // issue to contract
    if(totalTokenRewards > 0){
      blockchain.callWithAuth("token.iost", "issue",
      [this._getTokenName(),
        blockchain.contractName(),
        totalTokenRewards])  
    }
    storage.put('rewardProcessing', '0', tx.publisher)
  }


  processProducerBonus() {
    this._requireOwner();

    let isProcessing = storage.get('rewardProcessing', '0'); 

    if(isProcessing === '1') {
      throw "existing distribution ongoing";
    }

    let contractVotes = blockchain.call(
      "vote_producer.iost",
      "getVote",
      [blockchain.contractName()]
    );

    if (contractVotes && Array.isArray(contractVotes) && contractVotes.length >= 1) {
      contractVotes = contractVotes[0] === "" ? [] : JSON.parse(contractVotes[0]);
    }

    for (const contractVote of contractVotes) {
      const producerName = contractVote.option;
      const producerVotes = contractVote.votes;

      const voterCoef = new Float64(
        this._globalMapGet('vote_producer.iost', "voterCoef", producerName, "0")
      );

      const voterMask = new Float64(
        this._globalMapGet('vote_producer.iost', "v_" + producerName, blockchain.contractName(), "0")
      );

      let totalRewards = voterCoef.multi(producerVotes);
      let newRewards = new Float64(totalRewards.minus(voterMask).toFixed(8));

      const newCoef = newRewards.div(producerVotes);
      this._mapPut(MAP_PRODUCER_COEF, producerName, newCoef, tx.publisher);

    }

    blockchain.callWithAuth("vote_producer.iost", "voterWithdraw", [
      blockchain.contractName()
    ]);
  }

  claim(token) {
    if (!this._hasPool(token) && !this._hasPair(token)) {
      throw "NO_POOL_FOR_TOKEN";
    }

    var pool;
    var type;
    if(this._hasPair(token)){
      pool = this._getPair(token);
      type = 'pair';
    }else{
      pool = this._getPool(token);
      type = 'pool';
    }

    const userInfo = this._getUserInfo(tx.publisher);
    var userToken = token.split('_')[0];

    if (!userInfo[token]) {
      // Empty pool
      return;
    }

    const pending = new Float64(userInfo[token].rewardPending);
    const pendingStr = pending.toFixed(TOKEN_PRECISION, ROUND_DOWN);
    
    if (pending.gt(0)) {
      this._updatePool(token, pool);
      if(this._getTokenList().indexOf(token) >= 0){
        userToken = this._getTokenName();
      }else if(this._getPairList().indexOf(token) >=0){
        userToken = pool.tokenReward;
      }else if(token.indexOf(IOST_TOKEN) >= 0){
        userToken = this._getTokenName(); 
      }
      blockchain.callWithAuth("token.iost", "transfer",
        [userToken,
         blockchain.contractName(),
         tx.publisher,
         pendingStr,
         "Claiming token rewards"]);
      userInfo[token].rewardPending = "0";
    }

    var userAmount = new BigNumber(userInfo[token].amount);
    userInfo[token].rewardDebt = userAmount.times(pool.accPerShare).toFixed(TOKEN_PRECISION, ROUND_DOWN);
    this._setUserInfo(tx.publisher, userInfo);

    if(token.indexOf(IOST_TOKEN) >= 0 && this._hasPool(token)){
      // get claimable network rewards
      let userVotes = this._mapGet('userInfo', tx.publisher, {})
      if(userVotes[token]){
        let totalClaimable = new BigNumber(userVotes[token]['networkRewardPending'])
        totalClaimable = totalClaimable.toFixed(IOST_DECIMAL).toString()
        if(totalClaimable > 0){
          blockchain.callWithAuth(
            "token.iost",
            "transfer",
            [
              "iost",
              blockchain.contractName(),
              tx.publisher,
              totalClaimable,
              'Claiming network rewards'
            ]
          );
          blockchain.receipt(JSON.stringify(["claim network rewards ", 'iost', totalClaimable]));
        }
      }
    }
    blockchain.receipt(JSON.stringify(["claim", token, pendingStr]));
    this._addLog("claim", token, pendingStr)
  }

  getUserAmount(token, who) {
    const userInfo = this._getUserInfo(who);
    return userInfo[token] ? userInfo[token].amount : 0;
  }

  addProposal(proposalId, description, expirationDays) {
    this._requireOwner();

    storage.mapPut("proposal", proposalId, description, tx.publisher);

    const now = Math.floor(tx.time / 1e9);
    const days = 3600 * 24 * expirationDays

    storage.mapPut("proposalStat", proposalId, JSON.stringify({
      approval: 0,
      disapproval: 0,
      expiration: now + days,
      status: 'voting'
    }), tx.publisher);

    storage.mapPut("proposalVoters", proposalId, "[]");
  }

  changeProposal(proposalId, description) {
    this._requireOwner();
    storage.mapPut("proposal", proposalId, description, tx.publisher);
  }

  changeProposalStatus(proposalId, status) {
    this._requireOwner();

    const stat = this._getProposalStat(proposalId)
    stat.status = status
    this._setProposalStat(proposalId, stat)
  }

  _addOneVoter(proposalId, who) {
    const list = JSON.parse(storage.mapGet("proposalVoters", proposalId));
    list.push(who);
    storage.mapPut("proposalVoters", proposalId, JSON.stringify(list), tx.publisher);
  }

  _getProposalStat(proposalId) {
    return JSON.parse(storage.mapGet("proposalStat", proposalId));
  }

  _setProposalStat(proposalId, stat) {
    storage.mapPut("proposalStat", proposalId, JSON.stringify(stat), tx.publisher);
  }

  _setUserAction(proposalId, who, action) {
    const key = proposalId + ":" + who;
    const now = Math.floor(tx.time / 1e9);
    const stat = this._getProposalStat(proposalId);

    //update
    const amount = +this.getUserTokenAmount(who, JSON.stringify(this._getTokenList()))[0] || 0;
    if (amount > 0) {
      if (action * 1 > 0) {
        stat.approval += amount;
      } else {
        stat.disapproval += amount;
      }
    }

    stat.approval = +stat.approval.toFixed(UNIVERSAL_PRECISION);
    stat.disapproval = +stat.disapproval.toFixed(UNIVERSAL_PRECISION);
    this._setProposalStat(proposalId, stat);
    storage.mapPut("proposalAction", key, action.toString(), tx.publisher);
  }

  _hasUserAction(proposalId, who) {
    const key = proposalId + ":" + who;
    return storage.mapHas("proposalAction", key);
  }

  _actionOnProposal(proposalId, value) {
    if (this._hasUserAction(proposalId, tx.publisher)) {
      throw "Vote exists.";
    }

    const now = Math.floor(tx.time / 1e9);
    const stat = this._getProposalStat(proposalId);
    if (now > stat.expiration) {
      throw "Proposal expired.";
    }

    this._addOneVoter(proposalId, tx.publisher);
    this._setUserAction(proposalId, tx.publisher, value);
  }

  resetProposal(proposalId, who){
    const key = proposalId + ":" + who;
    storage.mapDel("proposalAction", key)
    const stat = this._getProposalStat(proposalId);
    stat.approval = 0
    stat.disapproval = 0
    this._setProposalStat(proposalId, stat);
  }

  approveProposal(proposalId) {
    this._actionOnProposal(proposalId, "1");
  }

  disapproveProposal(proposalId) {
    this._actionOnProposal(proposalId, "-1");
  }

  vote(token) {
    if (this._getTokenList().indexOf(token) < 0 && this._getPairList().indexOf(token) < 0 && token.indexOf(IOST_TOKEN) < 0) {
      throw 'Invalid token/pool.'
    }else if (token == 'iost'){
      throw 'Invalid token/pool.'
    }

    const userToken = this._getUserToken(tx.publisher);
    if (token == userToken) {
      throw "Vote exists."
    }

    if(userToken){
      this.unvote(userToken);  
    }
    
    this._setUserToken(tx.publisher, token);

    const amountStr = this.getUserTokenAmount(tx.publisher, JSON.stringify([token]));
    if (amountStr * 1 > 0) {
      this._addVote(token, amountStr);
    }

    this._addLog("vote", token, amountStr)
  }

  unvote(token) {
    if (this._getTokenList().indexOf(token) < 0 && this._getPairList().indexOf(token) < 0 && token.indexOf(IOST_TOKEN) < 0 ) {
      throw 'Invalid token/pool.'
    }else if (token == 'iost'){
      throw 'Invalid token/pool.'
    }

    const userToken = this._getUserToken(tx.publisher);
    if (token != userToken) {
      throw "Vote does not exists."
    }

    this._setUserToken(tx.publisher, "");

    const amountStr = this.getUserTokenAmount(tx.publisher, JSON.stringify([token]));
    if (amountStr * 1 > 0) {
      this._minusVote(token, amountStr);
    }

    this._addLog("unvote", token, amountStr)
  }

}

module.exports = Stake;
