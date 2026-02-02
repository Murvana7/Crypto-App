const logos = {
  bitcoin: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
  ethereum: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
  tether: "https://assets.coingecko.com/coins/images/325/large/Tether.png",
  litecoin: "https://assets.coingecko.com/coins/images/2/large/litecoin.png",
  cardano: "https://assets.coingecko.com/coins/images/975/large/cardano.png",
  dogecoin: "https://assets.coingecko.com/coins/images/5/large/dogecoin.png",
};

fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether,ethereum,litecoin,cardano,dogecoin&vs_currencies=usd&include_24hr_change=true')
  .then(res => res.json())
  .then(json => {
    const container = document.querySelector('.container');
    container.innerHTML = ""; // optional: clear before rendering

    const coins = Object.keys(json);

    for (const coin of coins) {
      const info = json[coin];
      const price = info.usd;
      const changeRaw = info.usd_24h_change;
      const change = (typeof changeRaw === "number") ? changeRaw.toFixed(5) : "N/A";

      container.innerHTML += `
        <div class="coin ${changeRaw < 0 ? 'falling' : 'rising'}">
          <div class="coin-logo">
            <img src="./images/${coin}.png" alt="${coin}"
                onerror="this.src='./images/bitcoin.png'">
          </div>
          <div class="coin-name">
            <h3>${coin}</h3>
            <span>/USD</span>
          </div>
          <div class="coin-price">
            <span class="price">$${price}</span>
            <span class="change">${change}</span>
          </div>
        </div>
      `;
    }
  })
  .catch(err => console.error(err));