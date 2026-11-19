# SaturnIA

Um chat de IA com um olho feito de partículas: a pupila acompanha o seu cursor, ele pisca, fica inquieto enquanto pensa e pulsa enquanto responde. Em volta, um anel como o de Saturno.

🔗 **Acesse:** https://ryanng0104.github.io/saturnia/

**100% gratuita:** roda no plano grátis do GitHub Pages e da Cloudflare, sem cartão e sem chave de API.

## Como funciona

```
Navegador (GitHub Pages)  ──POST /chat──▶  Cloudflare Worker  ──▶  Workers AI (Llama 3.3 70B)
        ◀──── resposta em tempo real (Server-Sent Events) ────
```

- **Site** (`index.html`, `css/`, `js/`): HTML, CSS e JavaScript puros, sem build. O olho é desenhado num `<canvas>` (`js/eye.js`).
- **Servidor** (`worker/`): um Cloudflare Worker que roda o modelo Llama 3.3 70B no **Workers AI**, a IA da própria Cloudflare, dentro da cota diária gratuita.

### Contas, histórico e memória

- **Contas:** cadastro e login com e-mail e senha, ou **com o Google**. A senha nunca é salva, só um hash PBKDF2 com sal. O login com o Google é conferido no servidor (assinatura RS256 com as chaves públicas do Google, `aud`, emissor, validade e e-mail verificado). Se o e-mail já tinha conta com senha, as duas formas de login passam a abrir a mesma conta. O login gera um token de sessão válido por 30 dias.
- **Boas-vindas e preferências:** no primeiro acesso, a SaturnIA pergunta como a pessoa quer ser chamada e qual cor ela prefere para os botões (roxo, azul, verde, rosa, laranja ou ciano). Tudo fica salvo na conta e pode ser trocado em **Configurações**, junto com o tema claro/escuro. A marca e o olho continuam roxos.
- **Histórico:** cada conversa e mensagem fica salva no banco **Cloudflare D1** (grátis), e aparece na barra lateral para abrir, continuar ou apagar.
- **Memória:** depois de cada mensagem, um modelo menor extrai fatos duradouros sobre a pessoa (nome, profissão, gostos…). Eles entram nas próximas conversas e podem ser vistos ou apagados no menu **Memórias**.

O formato do banco está em [`worker/schema.sql`](worker/schema.sql). Para ver os dados: painel da Cloudflare → **Storage & Databases → D1 → saturnia-db → Console**, ou pelo terminal:

```bash
cd worker
npx wrangler d1 execute saturnia-db --remote --command "SELECT name, email, created_at FROM users"
```

### Imagens (Júpiter) e Explorar (Terra)

- **Imagens:** descreva uma imagem e ela é gerada com o modelo **FLUX.1 schnell** (Workers AI, grátis). A descrição é traduzida para o inglês por um modelo pequeno, para um resultado melhor. As imagens ficam numa galeria por usuário (no D1), com opção de baixar e apagar. Limite de 25 imagens por dia por pessoa.
- **Explorar:** pergunte o que há por perto ("cafés para trabalhar em Pinheiros", "farmácia") usando sua localização ou um bairro escrito na pergunta. Os lugares vêm do **OpenStreetMap** (Nominatim), aparecem num mapa (Leaflet + tiles do OpenStreetMap) e em cards com endereço, horário, distância e link para o Google Maps, além de um resumo da SaturnIA feito só com esses dados (sem inventar notas).

### Proteções do servidor

- Só aceita pedidos vindos dos endereços em `ALLOWED_ORIGINS` (`worker/wrangler.toml`)
- Cada pessoa só acessa as próprias conversas e memórias
- Limite de 15 mensagens por minuto por usuário e de 10 tentativas de login por minuto por IP
- Limite de tamanho das mensagens e do histórico
- Quando a cota gratuita do dia acaba, o chat avisa e volta a funcionar no dia seguinte, sem cobrança

## Ligando a IA (uma vez só)

Você só precisa de uma **conta grátis na Cloudflare**: https://dash.cloudflare.com/sign-up (confirme o e-mail).

Depois, no terminal:

```bash
cd worker
npm install
npx wrangler login                                   # abre o navegador para entrar na Cloudflare
npx wrangler d1 create saturnia-db                   # cria o banco; copie o database_id para o wrangler.toml
npx wrangler d1 execute saturnia-db --remote --file=schema.sql   # cria as tabelas
npx wrangler deploy                                  # publica e mostra o endereço do servidor
```

O `deploy` mostra um endereço como `https://saturnia.SEU-SUBDOMINIO.workers.dev`. Coloque-o em `js/config.js`, sem barra no final:

```js
window.SATURNIA_CONFIG = {
  apiBase: 'https://saturnia.SEU-SUBDOMINIO.workers.dev',
};
```

Faça commit e push, e a SaturnIA está no ar.

### Ativando o login com o Google (opcional, grátis)

1. Em https://console.cloud.google.com crie um projeto e configure a **tela de consentimento OAuth** (tipo *Externo*).
2. Em **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**, escolha **Aplicativo da Web** e adicione a origem JavaScript `https://ryanng0104.github.io`.
3. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e coloque nos dois lugares:
   - `GOOGLE_CLIENT_ID` em `worker/wrangler.toml` → `npx wrangler deploy`
   - `googleClientId` em `js/config.js` → commit e push

O botão "Continuar com o Google" é próprio (no estilo da SaturnIA, com o logo oficial do Google) e usa o *token client* do Google Identity Services; o servidor confere o token com o Google antes de entrar.

Bancos criados antes desses recursos precisam das migrações em `worker/migrations/` (`0002_google_login.sql`, `0003_preferences.sql` e `0004_images.sql`).

### Trocando o modelo

O modelo fica em `MODEL`, no `worker/wrangler.toml`. Para ver os disponíveis: `npx wrangler ai models`.

## Rodando localmente

```bash
cd worker
npx wrangler dev        # http://localhost:8787 (usa o Workers AI da sua conta)

# em outro terminal, na raiz do projeto:
npx serve -l 5500 .     # http://localhost:5500
```

Em `js/config.js`, use `http://localhost:8787` enquanto testa.

## Estrutura

```
saturnia/
├── index.html
├── css/style.css
├── js/
│   ├── config.js     ← endereço do servidor
│   ├── eye.js        ← o olho de partículas
│   ├── markdown.js   ← formatação segura das respostas
│   └── app.js        ← login, conversas, memórias e chat
├── assets/favicon.svg
├── version.json      ← versão publicada (atualização automática)
└── worker/
    ├── src/index.js  ← servidor (Cloudflare Worker + Workers AI + D1)
    ├── schema.sql    ← tabelas do banco
    ├── wrangler.toml
    └── package.json
```

---

Criado por [Ryan Moreira](https://ryanng0104.github.io/portfolio/).
