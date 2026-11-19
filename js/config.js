/* =========================================================
   Configuração da SaturnIA
   ---------------------------------------------------------
   apiBase: endereço do servidor (pasta worker/), publicado com
   `npx wrangler deploy`. Sem barra no final.
   ========================================================= */

window.SATURNIA_CONFIG = {
  apiBase: 'https://saturnia.ryanng0104.workers.dev',

  // Login com o Google: "ID do cliente" criado no Google Cloud (termina em
  // .apps.googleusercontent.com). Precisa ser o mesmo de GOOGLE_CLIENT_ID no
  // worker/wrangler.toml. Vazio = botão do Google escondido.
  googleClientId: '',
};
