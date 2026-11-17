# Desafio Clínico — quiz em tempo real

Quiz estilo Kahoot sobre **fratura coronária complicada**, com a identidade visual da apresentação.
Sala única, perguntas fixas em `questions.js`, sem login.

## Como rodar

```bash
npm install
npm start
```

O terminal mostra:

- **Apresentador (projetor):** `http://localhost:3000/host` — abra no computador ligado ao projetor.
- **Jogadores:** o QR code na tela do apresentador já leva ao endereço com o PIN preenchido.
- **PIN padrão:** `2026`

### Celulares na mesma rede Wi-Fi

Por padrão o QR code usa o IP do computador na rede local (ex.: `http://192.168.1.152:3000`).
Os celulares precisam estar **no mesmo Wi-Fi** que o computador. Se o Windows perguntar,
permita o Node.js no firewall (redes privadas).

### Celulares em qualquer rede (4G, Wi-Fi da faculdade com isolamento etc.)

**Recomendado para o dia da apresentação:**

```bash
npm run online
```

Isso liga o servidor e um túnel público do `cloudflared` (precisa estar instalado:
`winget install Cloudflare.cloudflared`). Em alguns segundos o terminal mostra
"Endereço público pronto" e o QR code em `http://localhost:3000/host` passa a apontar
para o endereço `https://....trycloudflare.com` automaticamente. O endereço muda a cada execução.

## Hospedar no Render (grátis)

1. Envie este projeto para um repositório no GitHub.
2. Em [render.com](https://render.com), entre com o GitHub e clique em **New → Blueprint**.
3. Escolha o repositório. O Render lê o `render.yaml` e pede a **HOST_KEY** (senha do apresentador).
4. Clique em **Apply** e espere o deploy terminar (alguns minutos).
5. No projetor, abra `https://SEU-APP.onrender.com/host?senha=SUA_SENHA`.
   A senha some da barra de endereço logo depois de carregar. O QR code já aponta para o endereço do Render.

No plano gratuito o servidor "dorme" após ~15 min sem acesso e leva ~1 min para acordar:
abra a tela do apresentador alguns minutos antes de começar.
Se ficar parado no meio do jogo, o servidor pode reiniciar e o placar é perdido.

## Configurações (variáveis de ambiente)

| Variável     | Padrão      | Para quê                              |
|--------------|-------------|---------------------------------------|
| `PORT`       | `3000`      | Porta do servidor                     |
| `PIN`        | `2026`      | Código da sala                        |
| `PUBLIC_URL` | IP local    | Endereço usado no QR code             |
| `HOST_KEY`   | (vazio)     | Senha da tela `/host`; vazio = sem senha |

## Durante a apresentação

1. Abra `/host` no projetor e deixe a sala de espera visível enquanto todos entram.
2. Clique em um nome para remover alguém da sala.
3. **Começar o quiz** → cada pergunta tem 20 s; o tempo encerra sozinho quando todos respondem.
4. **Ver placar** → **Próxima pergunta**… até o **Pódio** (revela 3º, 2º e 1º).
5. Barra de espaço, seta → ou passador de slides também avançam.

Pontuação: resposta certa vale de 500 a 1000 pontos — quanto mais rápida, mais pontos. Errada vale 0.
Se o celular bloquear ou cair a conexão, ao reabrir a página o jogador volta com a mesma pontuação.

## Editar perguntas

Altere `questions.js`: `text`, quatro `options`, `correct` (índice 0–3) e `time` em segundos.
