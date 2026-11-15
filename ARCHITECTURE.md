# ARCHITECTURE.md — Distributed Wagering Processor

Este documento registra as decisões técnicas, trade-offs e limitações assumidas na construção do serviço — autocontido, sem depender de nenhum outro arquivo do repositório para ser lido e entendido.

*Esta é a versão oficial, final, rastreada pelo git — vive na raiz do projeto de código ao lado do `README.md` para que qualquer checkout (`git clone`) a inclua, independentemente de como o avaliador recebe o projeto. Uma cópia de trabalho em `Documents/ARCHITECTURE.md` foi usada durante o desenvolvimento (fora do controle de versão, junto do restante do planejamento interno em `Documents/`, listado no `.gitignore`) e era sincronizada aqui ao final de cada tarefa relevante; esta cópia na raiz é a autoritativa a partir de T308.*

---

## 1. Visão geral da arquitetura

O sistema segue um recorte de **DDD** (Domain-Driven Design) com **arquitetura orientada a eventos**, organizado em camadas:

- **Domínio** — `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`. Não depende de NestJS, do ORM nem de bibliotecas de infraestrutura. Toda invariante de negócio é validada aqui.
- **Aplicação** — casos de uso (`ProcessWagerTransactionUseCase`, `ReprocessPendingReferenceUseCase`, `PublishOutboxUseCase`, `ReconcileWalletUseCase`). O mesmo caso de uso é reutilizado pela entrada HTTP e pela entrada SQS — é o ponto de reuso que garante paridade de comportamento entre os dois canais.
- **Infraestrutura** — repositórios (MikroORM), publisher SQS, scheduler dos workers, logger estruturado, métricas.
- **Apresentação** — controllers HTTP e consumer SQS, ambos como adaptadores finos que apenas traduzem I/O e delegam para a camada de aplicação.

Diagramas completos (componentes, sequência HTTP, sequência SQS, deployment) em `Diagrams/Diagrama-Arquitetura.md`.

### 1.1 Padrões de domínio considerados e descartados: Event Sourcing e CQRS

Antes de fechar o desenho acima, três padrões táticos de DDD foram avaliados explicitamente: **Aggregate**, **Event Sourcing** e **CQRS**. A decisão não foi "usar DDD de forma genérica" — foi avaliar cada um à luz do que a especificação do desafio já prescreve e do que a tabela de pontuação (seção 14 do desafio) de fato recompensa.

**Aggregate — adotado.** Já é parte do esqueleto fornecido pela especificação: `Wallet` é explicitamente descrita como *Aggregate Root*, com construtor privado, factories estáticas (`open`/`rehydrate`) e invariantes encapsuladas (saldo nunca negativo, toda mudança de saldo com lançamento correspondente). Custo de adoção: zero — é a forma natural de implementar o modelo que o próprio desafio pede.

**Event Sourcing — considerado, não adotado.**
- *Por que foi cogitado:* o domínio já tem um log de fatos imutável e append-only (`WalletLedgerEntry`), que é precisamente a matéria-prima de um event store. Seria tentador tratar o ledger como fonte única da verdade e derivar `wallet.balance` por replay.
- *Por que foi descartado:* a própria especificação já modela `Wallet._balance` e `Wallet._version` como **estado materializado e persistido diretamente** — não como algo recalculado a cada leitura. O padrão pedido é "estado armazenado + log de auditoria verificado por reconciliação" (`wallet.balance == saldo reconstruído pelo ledger` é um *teste de consistência*, não o mecanismo normal de leitura do saldo). Implementar Event Sourcing de verdade exigiria replay de eventos (ou snapshotting para evitar replay completo a cada leitura), versionamento de esquema de eventos ao longo do tempo, e um mecanismo de concorrência no *append* do event store que não é mais simples do que o lock pessimista já escolhido — ou seja, não reduz a complexidade de concorrência, apenas a desloca, sem ganho para o critério de avaliação "Concorrência" (20 pontos). O ganho clássico de Event Sourcing (reconstruir qualquer estado passado, auditoria perfeita) já é coberto, para o que este desafio pede, pelo ledger imutável combinado com a reconciliação — sem o custo de reconstruir agregados por replay.
- *Trade-off aceito:* abrimos mão de "o estado é sempre derivável do zero a partir do log de eventos" em troca de simplicidade e aderência direta ao modelo já especificado, reduzindo o risco de gastar o prazo de 3 dias em infraestrutura (snapshot, versionamento de evento) que não está na tabela de pontuação.

**CQRS (com read model separado) — considerado, não adotado.**
- *Por que foi cogitado:* os endpoints de consulta (`GET /wallets/:id`, `GET /wallets/:id/ledger`, reconciliação) são, por natureza, leituras que poderiam viver em um modelo de leitura projetado e desnormalizado, separado do modelo de escrita — o desenho "clássico" de CQRS.
- *Por que foi descartado:* várias dessas leituras exigem **consistência forte com a escrita no mesmo instante**, não consistência eventual. O replay idempotente precisa devolver "o saldo observado naquele momento" exatamente como ele foi no commit original; a reconciliação compara o saldo armazenado com o saldo recalculado do ledger e **não pode** tolerar o lag de uma projeção assíncrona sem risco de reportar falso-positivo de inconsistência (prejudicando justamente o critério "Correção financeira", 20 pontos). Um read model separado traria exatamente o tipo de inconsistência observável que o desafio pede para detectar e expor — não para introduzir.
- *Alternativa "CQRS leve" também descartada:* usar o módulo `@nestjs/cqrs` apenas para separar handlers de comando e consulta (sem modelo de leitura separado, mesmo banco) foi considerado como meio-termo de baixo custo. Foi descartado por adicionar uma camada de indireção (command bus / query bus) que não resolve nenhum requisito do desafio e dificulta a leitura direta do caminho de execução — e "clareza das decisões técnicas" é um critério explícito de avaliação (seção 1 do desafio). Preferiu-se manter o caminho `Controller/Consumer → UseCase → Domínio → Repositório` direto e auditável.
- *Trade-off aceito:* abrimos mão de escalabilidade independente de leitura/escrita em troca de uma garantia mais simples de consistência estrita, que é exatamente o que os requisitos de idempotência e reconciliação exigem.

**Resumo da decisão:** Aggregate sim, Event Sourcing não, CQRS não — nem na forma completa (read model separado), nem na forma leve (apenas separação de handlers). Nenhum desses dois últimos padrões é recompensado pela tabela de pontuação, e ambos introduziriam risco real de consumir o prazo de 3 dias em infraestrutura não avaliada, ou de criar exatamente o tipo de inconsistência (saldo observado divergente, réplica de leitura desatualizada) que a seção 8 e a seção 9 (reconciliação) do desafio pedem para evitar.

### 1.2 Princípios SOLID aplicados

Os cinco princípios SOLID são adotados como guia de design em todas as camadas — não como selo decorativo, mas como critério concreto de onde cada classe/dependência deve (e não deve) apontar. Abaixo, cada princípio mapeado para decisões já tomadas neste documento:

**S — Single Responsibility.** Cada classe tem um único motivo para mudar: `Money` só conhece aritmética e validação de valores monetários; `Wallet` só garante as invariantes de saldo/versão; `WagerTransaction` só governa seu próprio ciclo de vida de status; cada caso de uso (`ProcessWagerTransactionUseCase`, `ReconcileWalletUseCase`, `PublishOutboxUseCase`, `ReprocessPendingReferenceUseCase`) resolve exatamente um fluxo de negócio; controllers e o consumer SQS só traduzem I/O (HTTP ou mensagem) para a chamada do caso de uso — nenhuma regra de negócio vive neles. Mudar a regra de `REFUND` não deveria exigir tocar no controller, e vice-versa.

**O — Open/Closed.** Novas variações se encaixam sem alterar o núcleo já escrito: `IntegrationEvent` é uma classe abstrata com uma subclasse concreta por evento (`WalletBalanceChanged`, `WagerTransactionProcessed`, etc.) — adicionar um evento novo não exige mexer no Outbox Publisher Worker, que só conhece o contrato abstrato. Da mesma forma, a taxonomia de `failureCode` e o enum `WagerTransactionKind` são pensados para crescer (novo tipo de operação, novo código de falha) sem reabrir a máquina de estados de `WagerTransaction`. O ponto de extensão de autenticação (`ProviderIdentityPort` + `AuthGuard` no-op, seção 11) segue o mesmo princípio: um `KeycloakAuthGuard` futuro se encaixa substituindo a implementação, sem alterar nenhum controller.

**L — Liskov Substitution.** Qualquer subclasse de `IntegrationEvent` deve poder ser usada onde o tipo abstrato é esperado, sem o Outbox Publisher Worker precisar saber qual evento concreto está publicando — ele só chama `toJSON()` e lê `eventType`/`version` do contrato comum. O mesmo vale para `AuthGuard`: o `NoopAuthGuard` de hoje e um `KeycloakAuthGuard` futuro são intercambiáveis no pipeline do NestJS sem quebrar nenhum contrato esperado pelos controllers.

**I — Interface Segregation.** Os *ports* usados pelos casos de uso são estreitos e específicos — ex.: um `WalletRepository` expõe apenas `findByIdForUpdate`/`save` (o que `ProcessWagerTransactionUseCase` realmente precisa), em vez de uma interface genérica "repositório de tudo"; o `ProviderIdentityPort` (seção 11) expõe só a extração de identidade do provedor, não um contrato de autenticação genérico. Isso evita que uma classe dependa de métodos que nunca usa — e evita, na prática, que o domínio importe a API completa do `EntityManager` do MikroORM (reforçando a restrição da seção 6.0 de que o domínio não depende do ORM).

**D — Dependency Inversion.** O domínio e os casos de uso dependem de abstrações (ports de repositório, port de publicação de eventos, `ProviderIdentityPort`), nunca de classes concretas de infraestrutura — é a formalização, como princípio de design explícito, de uma restrição que este documento já adota em outras seções: o domínio não conhece MikroORM nem decorators do NestJS. As implementações concretas (repositório MikroORM, publisher SQS) são ligadas via injeção de dependência do NestJS, na camada de infraestrutura, nunca importadas diretamente pelo domínio ou pelos casos de uso.

**Convenção de nomenclatura dos tokens de injeção.** Todo port do projeto exporta, junto da própria interface, seu token de injeção (`Symbol`) com o sufixo `_INTERFACE` — ex.: a interface `WalletRepository` exporta `WALLET_REPOSITORY_INTERFACE`. É a mesma convenção para qualquer port futuro (repositório, publisher de eventos, `ProviderIdentityPort`), não só para os de repositório — o sufixo mantém o nome do token visivelmente ligado ao contrato que ele representa, e evita que cada port improvise sua própria convenção de nome.

**Por que isso importa para o prazo de 3 dias:** essa inversão é o que torna os testes de unidade possíveis sem subir Postgres/LocalStack — um caso de uso testado contra um `WalletRepository` fake não precisa de infraestrutura real, enquanto os testes de integração seguem usando as implementações reais. Ou seja, SOLID aqui não é estética de código: é o que viabiliza a pirâmide de testes exigida pelo desafio dentro do tempo disponível.

---

### 1.3 Ordem de criação: schema do banco primeiro, entidade de domínio depois

Para cada agregado do domínio (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`), a migration que cria a tabela correspondente é escrita e aplicada **antes** de a classe de domínio existir — nunca o contrário, e nunca uma gerada a partir da outra. É uma decisão deliberada de sequenciamento e de método, não um acidente de cronograma nem uma peculiaridade do MikroORM.

**O que isso não é:** não é o "Database First" clássico de ferramentas de ORM, em que a classe de entidade é gerada por introspecção a partir de uma tabela já existente. Aqui as duas coisas são desenhadas de forma independente — o schema resolve suas próprias preocupações (tipos exatos, constraints, índices) e a classe de domínio resolve as suas (invariantes de negócio, transições de estado), sem uma derivar automaticamente a outra. A conexão entre elas é sempre explícita, feita por um repositório na camada de infraestrutura, que traduz entre a representação em colunas e a instância de domínio.

**Por que essa ordem, e não a inversa:** duas restrições já fechadas neste documento tornam essa sequência a única coerente.
- O domínio nunca importa tipos ou decorators do ORM (seção 6.0 da especificação do desafio, reforçada pelo princípio de Dependency Inversion acima). Isso descarta de imediato o "Code First" de ORM — anotar a classe de domínio com decorators e deixar o schema ser gerado a partir dela exigiria exatamente a dependência que está proibida.
- As garantias de unicidade, imutabilidade e não negatividade precisam existir no schema do banco, não apenas em código de aplicação — e isso em geral significa `CHECK`, índice único (inclusive parcial) e tipo de coluna escritos à mão em SQL de migration, independentemente de qualquer anotação de ORM. Como essa parte sempre vai precisar ser escrita manualmente, não há ganho em inverter a ordem.

Com essas duas restrições de pé, modelar o schema primeiro e a classe de domínio depois — cada um com sua própria leitura das mesmas regras de negócio, nunca um gerado do outro — é a forma mais direta de obter *persistence ignorance* real: a classe de domínio continua testável e compreensível sem qualquer conhecimento do banco, e o schema continua carregando sua própria defesa de integridade, independente de a aplicação se comportar corretamente ou não. Essa redundância entre as duas camadas é intencional, não desperdício: é exatamente a defesa em profundidade que o desafio original exige ao pedir que as garantias existam no schema, e não só na aplicação.

**Trade-off aceito:** como as duas modelagens são independentes, uma percepção de regra que só aparece ao desenhar a classe de domínio pode exigir uma migration adicional para ajustar o schema depois. Isso é tratado como evolução normal de schema versionado, não como falha do método — e seria exatamente o mesmo risco, só adiado, se a ordem fosse invertida.

**Até onde essa defesa em profundidade foi levada em `wallet_ledger_entries`:** a constraint `wallet_ledger_entries_balance_arithmetic_check` é um `CHECK` aritmético que confere, na própria linha, que `balance_after_amount` é consistente com `balance_before_amount`, `money_amount` e `direction` — o banco rejeita um `INSERT` cuja aritmética não bate, mesmo que o bug esteja inteiramente na camada de aplicação. O que **não** foi adotado: `REVOKE UPDATE, DELETE` não foi aplicado ao usuário de runtime sobre essa tabela — a imutabilidade do ledger (seção 1.5.1) continua garantida apenas pela ausência de qualquer código de aplicação que escreva um `UPDATE`/`DELETE` nela, nunca reforçada por uma permissão de banco negada. É uma limitação consciente, não um esquecimento: para o ambiente de avaliação deste desafio, nenhum caminho de código tenta essa escrita; um ambiente de produção real se beneficiaria do `REVOKE` como segunda linha de defesa contra um acesso direto ao banco fora da aplicação (um script administrativo, uma migration futura mal escrita), e fica registrado aqui para não ser esquecido.

---

### 1.4 Convenções de projeto, nomenclatura e estruturação

Para garantir consistência estrita, previsibilidade entre camadas e evitar decisões de estilo improvisadas ao longo do desenvolvimento, um conjunto uniforme de convenções arquiteturais e de nomenclatura foi estabelecido na concepção do projeto. Todas as camadas devem seguir rigorosamente estes padrões:

#### 1.4.1 Organização de camadas e restrições de importação

* **Domínio (`domain/`)**: Contém entidades, objetos de valor, agregados, contratos de eventos e erros de domínio. É o núcleo agnóstico do sistema: é expressamente proibido importar qualquer módulo ou decorador de frameworks externos (como NestJS ou ORMs), restrição que é fiscalizada automaticamente pelas regras de linter do projeto.
* **Aplicação (`application/`)**: Contém casos de uso (`use-cases/`) e portas abstratas (`ports/`). Conhece apenas o domínio e contratos de infraestrutura desacoplados.
* **Infraestrutura (`infrastructure/`)**: Contém implementações concretas de repositórios, clientes de mensageria, migrations de banco de dados e resolução de configurações de ambiente.
* **Apresentação (`presentation/`)**: Contém adaptadores primários de entrada (controladores HTTP, consumidores de filas, agendadores de processos em segundo plano e filtros de exceção).

#### 1.4.2 Nomenclatura de arquivos e pastas

* **Padrão base**: Todo diretório e arquivo de código utiliza exclusivamente `kebab-case`.
* **Sufixos semânticos por papel arquitetural**:
  * Casos de uso: `*.use-case.ts`
  * Entidades de persistência ORM: `*.entity.ts`
  * Portas e implementações de repositório: `*.repository.ts`
  * Controladores HTTP: `*.controller.ts`
  * Módulos de injeção de dependência: `*.module.ts`
  * Agendadores de workers (background): `*.scheduler.ts`
  * Consumidores de filas/mensageria: `*.consumer.ts`
  * Filtros globais de exceção: `*.filter.ts`
  * Migrations de banco de dados: `Migration<YYYYMMDDHHMMSS>_<DescricaoPascalCase>.ts`
  * Testes de unidade: `*.spec.ts`
  * Testes de integração: `*.integration.spec.ts`
  * Testes de ponta a ponta (HTTP): `*.e2e.spec.ts`
  * Testes de concorrência: alocados em diretório de teste isolado dedicado a concorrência.

#### 1.4.3 Nomenclatura de classes e tipos

* **Padrão base**: Todas as classes, interfaces e tipos utilizam `PascalCase`.
* **Regras por categoria**:
  * **Agregados e Entidades de Domínio**: Nomeados puramente com o substantivo conceitual do domínio (`<Entidade>`), sem prefixos ou sufixos de persistência ou framework.
  * **Casos de Uso**: Nomeados no formato `<Acao><Entidade>UseCase`, expressando claramente o fluxo de negócio executado.
  * **Entidades ORM (Banco de Dados)**: Nomeadas com o sufixo explícito `<Entidade>Entity`, mantendo distinção visual e conceitual clara da entidade de domínio homônima.
  * **Implementações de Repositório**: Nomeadas no formato `<Entidade><Tecnologia>Repository`, indicando a biblioteca ou mecanismo tecnológico empregado.
  * **Controladores HTTP**: Nomeados com o substantivo do recurso no plural seguido de sufixo: `<EntidadesPlural>Controller`.
  * **Agendadores de Workers**: Nomeados no formato `<Finalidade>Scheduler`.
  * **Consumidores de Mensageria**: Nomeados no formato `<Entidade><Canal>Consumer`.
  * **Classes de Erro de Domínio**: Nomeadas no formato `<CausaEspecifica>Error`, estendendo obrigatoriamente uma das cinco categorias base de erro de domínio da arquitetura.
  * **Eventos de Integração**: Nomeados com o fato de negócio consolidado no particípio/passado: `<Entidade><FatoOcorrido>`.

#### 1.4.4 Nomenclatura de métodos e funções

* **Padrão base**: Métodos e funções utilizam sempre `camelCase`.
* **Entidades de Domínio**:
  * Construtores de entidades são sempre privados ou protegidos (`private constructor`), impedindo instanciação arbitrária com estado inconsistente.
  * Instanciação e recriação ocorrem unicamente por fábricas estáticas explícitas: fábricas de criação de novo estado (`create`, `open`), fábricas a partir de valores básicos (`from`, `zero`), ou fábrica de reconstituição a partir do banco de dados (`rehydrate`), a qual reconstrói a entidade sem revalidar regras de transição.
  * Métodos de negócio utilizam verbos no imperativo que denotam intenção (`debit`, `credit`, `touch`, `markProcessed`).
  * Métodos de checagem e predicados booleanos são prefixados com `is` ou `has`.
  * Métodos de serialização padronizados como `toJSON()` e `toString()`.
* **Casos de Uso**:
  * Expõem um único método de execução principal: `async execute(command: <Acao>Command): Promise<Result>`.
* **Portas de Repositório**:
  * Métodos de leitura utilizam o prefixo `findBy...` (ex.: `findById`, `findByIdForUpdate`, `findBy<Criterios>`).
  * Método de persistência utiliza a convenção uniforme `save(aggregate): Promise<void>`.
* **Controladores HTTP**:
  * Métodos de ação recebem nomes concisos correspondentes ao verbo e propósito (`create`, `get`, `process`, `reconcile`).
* **Funções de Tradução e Mapeamento**:
  * Funções puras na camada de persistência para converter representações: `<entidade>ToDomain(entity)` e `<entidade>ToEntityData(aggregate)`.
  * Funções puras de formatação na camada de apresentação: `toResponseBody(aggregate)`.

#### 1.4.5 Nomenclatura de propriedades, variáveis e identificadores de injeção

* **Propriedades públicas, argumentos e variáveis**: Sempre em `camelCase`.
* **Propriedades privadas de backing field no Domínio**: Quando uma propriedade interna privada possui um getter público homônimo, utiliza-se o prefixo `_` (underscore) no campo privado.
* **Constantes e limites de configuração**: `UPPER_SNAKE_CASE` para constantes em nível de arquivo ou estáticas de classe (ex.: limites numéricos, regex de formatação, tempos de espera).
* **Tokens de Injeção de Dependência (`Symbol`)**: Sempre declarados em `UPPER_SNAKE_CASE` com o sufixo obrigatório `_INTERFACE` (ex.: `<NOME_DA_PORTA>_INTERFACE`), conforme definido na seção 1.2.

#### 1.4.6 Interfaces, Comandos e Schemas

* **Objetos de Parâmetros de Domínio**: Nomeados como `<Entidade>Props` ou `Create<Entidade>Props` para novos registros, e `<Entidade>State` para a estrutura de dados bruta de reidratação.
* **Comandos de Caso de Uso**: Nomeados como `<Acao>Command`.
* **Corpos de Resposta HTTP**: Nomeados como `<Acao>ResponseBody` ou `<Entidade>ResponseBody`.
* **Schemas de Validação (Zod)**: Declarados em `camelCase` com o sufixo obrigatório `Schema` (ex.: `<finalidade>BodySchema`, `<parametro>ParamSchema`, `envSchema`).

#### 1.4.7 Convenções de Banco de Dados Relacional e Migrations

* **Nomes de tabelas**: Substantivos no plural, em `snake_case`.
* **Nomes de colunas**: Sempre em `snake_case`.
* **Valores monetários**: Definidos obrigatoriamente como `numeric(19,2)` no banco de dados e tipados estritamente como `string` no TypeScript em todas as camadas da aplicação (vedado o uso de tipos de ponto flutuante).
* **Identificadores e chaves**: Colunas de identidade e identificadores externos são sempre tipados nativamente como `uuid` no PostgreSQL e como `string` na aplicação.
* **Nomenclatura de constraints e índices**:
  * Chaves primárias: `<tabela>_pkey`
  * Chaves de unicidade: `<tabela>_<colunas>_unique`
  * Restrições de checagem: `<tabela>_<regra>_check`
  * Índices secundários: `<tabela>_<colunas>_idx`
* **Desacoplamento de agregados no banco**: Agregados de domínio distintos nunca possuem vínculos relacionais automáticos no ORM (como navegações automáticas bidirecionais). Suas chaves de ligação são mantidas puramente como colunas escalares de tipo `uuid`, preservando fronteiras transacionais isoladas por agregado.
* **Enumerações fechadas (`kind`, `status`, `direction`, etc.)**: sempre `text` com uma constraint `CHECK` por lista de valores — nunca um tipo `ENUM` nativo do Postgres. Adicionar um valor novo a um `ENUM` nativo (`ALTER TYPE ... ADD VALUE`) não pode ser revertido numa migration `down()` e, em algumas versões do Postgres, não pode rodar dentro de uma transação com outras alterações — exatamente o tipo de atrito que o ciclo de migrations deste projeto (seção 1.3) evita. Trocar a lista de um `CHECK` é um `ALTER TABLE` comum, reversível como qualquer outra migration.

#### 1.4.8 Formatação e Diretrizes de Código

* **Estilo**: Indentação de 2 espaços, limite de largura de linha de 100 caracteres e uso de aspas duplas.
* **Ausência de metadados de processo**: É proibido incluir códigos de rastreabilidade, numeração de tarefas de planejamento ou referências a requisitos em nomes de arquivos, classes, variáveis, testes ou comentários de código. A rastreabilidade reside exclusivamente na documentação técnica e no histórico de commits.
* **Finalidade dos comentários**: Comentários no código são restritos a justificar o *porquê* de escolhas de alto impacto, garantias de concorrência ou invariantes não óbvias. Comentários que meramente reescrevem o que o código faz são dispensados.

---

### 1.5 Taxonomia e catálogo de componentes do sistema

Para manter a complexidade sob estrito controle e assegurar que cada parte do software possua uma fronteira conceitual única e auditável, os componentes do sistema são organizados segundo uma taxonomia bem delimitada. O design rejeita proliferações artificiais de classes (como barramentos de comando genéricos ou microsserviços prematuros), mantendo um conjunto compacto de elementos de alta coesão:

#### 1.5.1 Núcleo de Domínio (`domain/`)

Isolado de dependências tecnológicas e frameworks, encapsula todas as regras e garantias invariáveis:

* **Agregado Raiz (`Wallet`):** Governa saldo, moeda e controle de concorrência (`version`). Garante a invariante de que o saldo nunca se torna negativo e assegura que a versão só seja incrementada em mutações que efetivamente alterem o saldo financeiro.
* **Entidade de Negócio (`WagerTransaction`):** Máquina de estados finita que governa o ciclo de vida transacional (`PENDING`, `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `FAILED`), validando transições irreversíveis e regras de associação de referências.
* **Entidade Contábil Imutável (`WalletLedgerEntry`):** Livro-razão (*ledger*) estruturalmente imutável (*append-only*). Registra o histórico auditável com snapshot do saldo imediatamente anterior e posterior a cada lançamento.
* **Entidades de Resiliência Distribuída (`OutboxMessage` e `InboxMessage`):** Sustentam os padrões transacionais de garantia de entrega e recepção: a `OutboxMessage` enfileira eventos atômicos junto da transação no banco; a `InboxMessage` garante deduplicação persistente de mensagens recebidas de filas externas.
* **Objeto de Valor (`Money`):** Estrutura imutável de precisão arbitrária que encapsula valor monetário (duas casas decimais fixas) e código de moeda, impedindo representações em ponto flutuante em todo o ciclo de vida da aplicação.
* **Taxonomia de Erros de Domínio (`DomainError`):** Hierarquia estrita de 5 classes abstratas de erro que mapeiam univocamente causas de falha para a semântica de resposta de apresentação (validação de payload, regra de negócio, conflito de recurso, recurso não encontrado e falha de infraestrutura).
* **Eventos de Integração (`IntegrationEvent`):** Contratos de fatos imutáveis (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) serializáveis em JSON para consumo externo.

#### 1.5.2 Camada de Aplicação (`application/`)

Orquestra casos de uso e desacopla a lógica das interfaces de entrada:

* **Casos de Uso Transacionais de Negócio:**
  * `CreateWalletUseCase`: Criação de carteiras com verificação de unicidade por jogador e moeda, suportando abertura com saldo inicial e emissão atômica de lançamento no ledger.
  * `ProcessWagerTransactionUseCase`: Ponto central de execução financeira para todas as operações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), aplicando lock pessimista por linha na carteira, cálculo de deduplicação e gravação atômica outbox/ledger.
* **Casos de Uso de Consulta e Diagnóstico** (fase 3 — consultas, nenhum move estado financeiro):
  * `GetWalletUseCase`: Consulta rápida de saldo consolidado e versão atual da carteira.
  * `GetWalletLedgerUseCase`: Pagina o extrato (`WalletLedgerEntry`) de uma carteira por cursor opaco assinado (seção 6.1).
  * `GetWagerTransactionUseCase`: Consulta uma transação pelo seu id interno.
  * `GetWagerTransactionByProviderUseCase`: Mesma consulta, pela chave de negócio do provedor `(providerId, externalTransactionId)`.
  * `ReconcileWalletUseCase`: Recalcula o saldo a partir do ledger inteiro e compara com o saldo materializado, sob isolamento `REPEATABLE READ` sem lock pessimista (seção 5.1); nunca corrige, só sinaliza divergência.
* **Casos de Uso Assíncronos e de Resiliência:**
  * `ConsumeWagerTransactionMessageUseCase`: Orquestra o consumo de mensagens de entrada via mensageria, integrando idempotência via inbox com o processamento do caso de uso transacional.
  * `PublishOutboxUseCase`: Reivindica mensagens pendentes na outbox usando concorrência não bloqueante e as despacha para a fila de mensageria externa.
  * `ReprocessPendingReferenceUseCase`: Identifica transações que aguardam referências fora de ordem e as submete a reprocessamento com política de recuo exponencial.
* **Serviços de Domínio e Apoio:**
  * `ReferenceResolver`: Avalia e classifica o estado de transações passadas referenciadas por operações dependentes em 5 categorias resolutivas.
  * `ReversalEffect`: Calcula a direção contábil inversa e o valor exigido para estornos e reversões.
  * `WagerTransactionPayloadHash`: Calcula o hash canônico SHA-256 de campos essenciais de negócio para detecção de adulteração de payload em replays idempotentes.
* **Portas de Abstração (`ports/`):**
  * Contratos de repositório (`WalletRepository`, `WagerTransactionRepository`, `WalletLedgerEntryRepository`, `OutboxMessageRepository`, `InboxMessageRepository`) e publicação (`IntegrationEventPublisher`), injetados por tokens `*_INTERFACE`.

#### 1.5.3 Camada de Apresentação (`presentation/`)

Adaptadores finos que traduzem protocolos externos e delegam aos casos de uso:

* **Controladores HTTP de Negócio (`wallets/`, `wagering/`):** `WalletsController` (criação, consulta, ledger paginado, reconciliação) e `WageringController` + `ProviderWagerTransactionsController` (submissão de apostas e as duas formas de consulta de transação — por id interno e por chave do provedor).
* **Controladores HTTP de Diagnóstico (`health/`, `metrics/`):** `HealthController` (`/health/live`), `HealthReadyController` (`/health/ready`) e `MetricsController` (`/metrics`) — nenhum deles sob o `AuthGuard` de negócio (seção 11).
* **Consumidor de Mensageria (`sqs-consumer/`):** Adaptador de longa espera (*long polling*) da fila FIFO de transações com encerramento gracioso (*graceful shutdown*) sob sinais de término do processo.
* **Agendadores em Segundo Plano (`schedulers/`):**
  * `OutboxPublisherScheduler`: Ciclo contínuo de publicação assíncrona de eventos.
  * `OutboxLagSamplerScheduler`: Ciclo próprio e independente do publisher que amostra `outbox_lag_seconds` (seção 12.3) — continua medindo mesmo com o publisher pausado, propositalmente.
  * `PendingReferenceReprocessorScheduler`: Ciclo contínuo de reprocessamento de transações com referências pendentes.
  * `DlqMonitorScheduler`: Inspeção passiva e sinalização da fila de dead-letter sem descarte de mensagens.
* **Filtros Globais de Exceção:** Tradutor que intercepta as 5 categorias de erro de domínio e as verte nos códigos de status HTTP correspondentes.

#### 1.5.4 Camada de Infraestrutura (`infrastructure/`)

Conexão com os mecanismos concretos de armazenamento e comunicação:

* **Mapeamento de Persistência (MikroORM):** Entidades com esquemas de tabela explícitos (`*Entity`) e repositórios com controle de transação e lock pessimista (`SELECT ... FOR UPDATE`).
* **Mensageria Externa (AWS SQS / LocalStack):** Implementação concreta de despacho de mensagens com garantia de ordenação por grupo de partição.
* **Esquemas e Validação de Ambiente:** Módulo de carregamento e validação estrita das variáveis de ambiente na inicialização do serviço.

#### 1.5.5 Resumo Quantitativo e Dimensão do Escopo

A arquitetura mantém uma quantidade deliberadamente compacta e controlada de elementos:

| Camada | Contagem e Componentes |
| :--- | :--- |
| **Domínio** | 5 Entidades/Agregados (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `OutboxMessage`, `InboxMessage`), 1 Value Object (`Money`), 1 Hierarquia de Erros (5 categorias), 4 Eventos de Integração. |
| **Aplicação** | 10 Casos de Uso (2 transacionais de negócio, 5 de consulta/diagnóstico, 3 de resiliência/mensageria), 3 Serviços de Apoio, 6 Portas de Abstração. |
| **Apresentação** | 3 Controladores de Negócio + 3 de Diagnóstico, 1 Consumidor SQS, 4 Agendadores de Background, 1 Filtro Global de Erros. |
| **Infraestrutura** | 5 Repositórios MikroORM, 1 Publicador de Mensageria, 1 Serviço de Configuração. |

Essa estrutura restrita evita camadas intermediárias desnecessárias, assegurando que o caminho de execução `Apresentação → Caso de Uso → Domínio → Persistência` seja linear, facilmente auditável e com tempos de execução determinísticos.

---

## 2. Stack e por que

| Item | Escolha | Justificativa |
|---|---|---|
| Runtime/test runner | Bun 1.x | Exigência do desafio; usado também para execução dos testes de integração/concorrência, reduzindo a necessidade de ferramentas adicionais de test runner. |
| Linguagem | TypeScript estrito | Exigência do desafio; `strict: true` previne classes inteiras de bug (null/undefined implícito) que seriam especialmente perigosas em um domínio financeiro. |
| Framework | NestJS | Exigência do desafio; injeção de dependência e módulos bem definidos ajudam a manter os boundaries entre domínio/aplicação/infraestrutura explícitos. |
| Banco | PostgreSQL | Exigência do desafio; suporta `SELECT ... FOR UPDATE`, `SELECT ... FOR UPDATE SKIP LOCKED`, `CHECK` constraints e índices únicos parciais — todos usados nas decisões abaixo. |
| Mensageria | SQS (LocalStack) | Exigência do desafio; filas FIFO com `MessageGroupId` dão ordenação best-effort por wallet, tratada como otimização, nunca como garantia. Configuração de `MessageGroupId` e `VisibilityTimeout` fixada na seção 2.2. |
| Orquestração local | Docker Compose | Exigência do desafio; usado para reproduzir o ambiente de avaliação com múltiplas instâncias da aplicação. |
| ORM | **MikroORM** | Escolhido sobre TypeORM (ambos aceitos). Critério de decisão na seção 3. |
| Adaptador HTTP do NestJS | **Express** (`@nestjs/platform-express`) | Escolhido sobre Fastify (ambos aceitos pelo desafio). Critério de decisão na seção 2.1. |
| Lint/format | **Biome** | Escolhido sobre ESLint + Prettier (ambos aceitos pelo desafio). Critério de decisão na seção 2.1. |

---

### 2.1 Por que Express e por que Biome

**Express, não Fastify.** O desafio delega a escolha do adaptador HTTP ao candidato, pedindo justificativa apenas se não for Express. Express foi mantido por ser o adaptador padrão do NestJS (`nest new`) e por não haver, na tabela de pontuação do desafio, nenhum requisito de performance de HTTP que justifique o desvio para Fastify. Reversão custa mais que um refactor simples: todo controller/guard/interceptor escrito ao longo do projeto assume a API de request/response do Express.

**Biome, não ESLint + Prettier.** O desafio também aceita "biome ou eslint+prettier, sua escolha". Biome foi escolhido por cobrir lint e format em uma única ferramenta/config, com regras padrão suficientes ("sem regras exóticas, padrão recomendado já basta") — incluindo a regra `noRestrictedImports`, usada para impedir que `src/domain/` importe `@nestjs/*`/`@mikro-orm/*` (reforçando a restrição da seção 6.0 de que o domínio não depende de infraestrutura).

---

### 2.2 Configuração das filas SQS: `MessageGroupId` e `VisibilityTimeout`

Duas decisões de configuração das filas FIFO ficam fixadas aqui, antes da implementação do consumer e do outbox publisher (Fase 2), para não serem decididas ad-hoc no meio dessas tarefas.

**`MessageGroupId` é sempre o `walletId`** — tanto em `wager-transactions.fifo` (mensagens de entrada) quanto na fila de eventos de integração publicada pelo Outbox Publisher Worker (o `MessageGroupId` do evento publicado é o `aggregateId`, que é o `walletId`). Dentro de um mesmo `MessageGroupId`, o SQS FIFO entrega mensagens estritamente em ordem e nunca entrega a próxima do mesmo grupo antes de a anterior ser confirmada ou expirar — é exatamente a granularidade de serialização que o domínio já exige no banco (seção 5): fixar `MessageGroupId = walletId` faz a fila reforçar, como otimização, a mesma unidade de concorrência que o lock pessimista garante como regra. As duas alternativas mais tentadoras foram descartadas deliberadamente:
- um `MessageGroupId` fixo (ou derivado de `providerId`) serializaria mensagens de wallets completamente distintas dentro do mesmo grupo, destruindo o paralelismo entre jogadores que a restrição inviolável 6 exige;
- um `MessageGroupId` por mensagem individual (ex.: o próprio `messageId`) perderia qualquer ordenação best-effort dentro da mesma wallet, aumentando sem necessidade a frequência de `PENDING_REFERENCE` mesmo quando o provedor envia `BET` e seu eventual `REFUND`/`ROLLBACK` na ordem correta.

**A fila de eventos de integração se chama `integration-events.fifo`.** Precisa ser FIFO (não uma fila padrão) exatamente por depender de `MessageGroupId`, que o SQS só aceita em filas FIFO — e toda fila FIFO exige o sufixo `.fifo` no nome. Cada mensagem publicada carrega `MessageDeduplicationId` igual ao próprio `id` da mensagem da outbox (nunca `ContentBasedDeduplication`): o identificador de dedup já existe e é estável por natureza, gerar outro a partir do conteúdo seria redundante.

**`VisibilityTimeout` de `wager-transactions.fifo` (e, por simetria, de `wager-transactions-dlq.fifo`) é `30` segundos.** O número parte do pior caso de tempo de processamento de uma única mensagem: o `lock_timeout` fixado na seção 5.2 limita a 5s a espera pelo lock da wallet; a transação em si (validação de idempotência, validação de domínio, inserts de transação/ledger/outbox e commit) não faz nenhuma chamada de rede externa síncrona — a publicação do evento é assíncrona, via outbox — e deve concluir em poucas dezenas de milissegundos mesmo em ambiente de containers local. Aplicando uma margem de segurança generosa (da ordem de 6x o pior caso de espera pelo lock) para absorver a variância de I/O do ambiente de avaliação, 30s evita os dois erros opostos: um valor baixo demais devolveria a mensagem à fila (redelivery) enquanto ela ainda está em processamento legítimo, criando concorrência espúria sobre a mesma mensagem — mitigada pela inbox, mas custando throughput e ruído nos logs; um valor alto demais atrasaria a reentrega real em caso de falha de um consumidor, sem ganho correspondente. A DLQ não tem consumidor automático processando-a continuamente — existe para retenção e auditoria manual —, então o mesmo valor é mantido apenas por simetria operacional, não por necessidade de cálculo próprio.

**`maxReceiveCount` da redrive policy (`wager-transactions.fifo` → `wager-transactions-dlq.fifo`) é `5`.** Com `VisibilityTimeout=30s`, isso limita a no máximo ~150s de redelivery antes de uma mensagem cair na DLQ. O valor é deliberadamente curto quando comparado às outras duas janelas de retry do sistema: o Outbox Publisher Worker (seção 7) tenta publicar um evento já comitado indefinidamente — só o atraso entre tentativas tem teto, nunca o número de tentativas —, e o reprocessador de referências fora de ordem (seção 8) espera até 10 tentativas ou 24h por uma referência de negócio que ainda pode chegar. A DLQ cobre um fenômeno diferente dos outros dois: falha de **infraestrutura** no processamento de uma mensagem de entrada (ex.: Postgres indisponível), nunca a espera legítima por um evento de negócio futuro nem a entrega de um evento já comitado. Represar a fila principal por mais tempo não traria benefício correspondente, e uma mensagem na DLQ não é dado perdido — fica retida para auditoria manual (fora de escopo reprocessá-la automaticamente). Um valor maior só prolongaria o ruído de redelivery sem ganho; um valor menor arriscaria desviar para a DLQ uma falha transitória genuinamente curta com margem insuficiente.

A distinção entre as três categorias que decidem o destino de uma mensagem consumida de `wager-transactions.fifo` — erro de negócio (sempre confirmado, nunca vai à DLQ), erro transitório/desconhecido (nunca confirmado, redelivery natural da própria fila) e falha permanente de infraestrutura (mesmo caminho do erro transitório; é a própria fila, via `maxReceiveCount`, quem a desvia para a DLQ depois de esgotadas as tentativas) — nunca depende de inspecionar a mensagem de erro em texto livre: é sempre por tipo/classe de erro, reutilizando a mesma hierarquia de `DomainError` da seção 9/10. Uma instância rodando em qualquer réplica da aplicação loga um aviso estruturado sempre que a DLQ tiver uma ou mais mensagens (seção 12) — um monitor periódico que só lê o atributo agregado da fila (`ApproximateNumberOfMessages`), nunca consome (`ReceiveMessageCommand`) nem apaga nada dela, para não esconder uma mensagem de quem estiver fazendo auditoria manual ao mesmo tempo.

---

### 2.3 Topologia multi-instância: serviços nomeados, não `deploy.replicas`

O `docker-compose.yml` final sobe **3 serviços nomeados** (`app-1`, `app-2`, `app-3`, mesma configuração via um `x-app-service` compartilhado) atrás de um `nginx` fazendo round-robin — nunca `deploy.replicas`/`docker compose up --scale app=3`. A alternativa com `--scale`/`deploy.replicas` foi descartada porque todas as réplicas resultantes compartilham o mesmo nome de serviço, o que impede dar a cada uma um `hostname` distinto — e o `hostname` de cada container é o único dado que diferencia, num log estruturado (seção 12.1), qual réplica física processou uma dada requisição; com nomes fixos, isso sai de graça (`hostname: app-1`/`app-2`/`app-3` sobrescrevendo só esse campo, nada do código da aplicação muda). `nginx` foi escolhido como balanceador por já constar entre as opções aceitas para esse papel e por seu `proxy_next_upstream` padrão (erro/timeout) já tirar uma réplica parada da rotação sem configuração adicional.

**Migrations em serviço `migrate` separado, nunca dentro do boot de `app-*`.** Um serviço one-shot (`migrate`, restart `"no"`) roda `bun run migration:up` uma única vez, antes de qualquer `app-*` subir (`depends_on: service_completed_successfully`). Rodar a migration dentro do próprio processo da aplicação faria as 3 réplicas tentarem aplicá-la ao mesmo tempo na inicialização, sem nenhuma garantia de lock distribuído contra essa corrida específica — separar em um serviço prévio elimina o problema por construção, em vez de depender de um mecanismo de coordenação adicional.

---

## 3. Por que MikroORM

MikroORM foi preferido por três motivos concretos, todos citados como vantagem explícita na especificação do desafio:

1. **`EntityManager.transactional()`** dá um limite transacional explícito e composicional — a mesma função que grava `wager_transaction` grava `wallet`, `wallet_ledger_entry`, `inbox_message` e `outbox_message` dentro do mesmo `transactional()`, sem a necessidade de passar um `QueryRunner` manualmente por várias camadas (como seria necessário no TypeORM para o mesmo nível de controle).
2. **`LockMode`** (`PESSIMISTIC_WRITE`) é de primeira classe na API do `EntityManager.findOne(..., { lockMode })`, o que torna o lock por `walletId` (seção 5) uma linha de código no repositório, não uma query SQL manual espalhada pela aplicação.
3. **Unit of Work + Identity Map** reduzem o risco de duas partes do mesmo caso de uso carregarem representações divergentes da mesma `Wallet` dentro da mesma transação — importante porque o caso de uso manipula `Wallet`, `WagerTransaction` e `WalletLedgerEntry` como um grafo de agregados relacionados.

**Trade-off aceito:** MikroORM tem uma comunidade menor que o TypeORM e uma curva de aprendizado um pouco maior em torno do Unit of Work explícito. Para o prazo de 3 dias, esse custo é pago uma vez (setup) e amortizado pelo ganho de clareza no desenho transacional, que é justamente o que está sendo avaliado.

---

## 4. Modelagem de `Money` e mapeamento no banco

- **Domínio:** `Money` encapsula um `Decimal` (biblioteca `decimal.js` ou equivalente) e a moeda (ISO-4217). Imutável; toda operação (`add`, `subtract`, `negate`) retorna uma nova instância. Construído apenas via `Money.from({ amount: string, currency: string })` ou `Money.zero(currency)`.
- **Validação:** `Money.from` rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais e valores negativos quando o contrato de entrada exige não-negatividade (ex.: `initialBalance`, `money` de uma operação). Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- **Persistência:** duas colunas por campo monetário — `amount NUMERIC(19,2) NOT NULL` e `currency CHAR(3) NOT NULL`. Nunca `FLOAT`/`DOUBLE`. `NUMERIC` do PostgreSQL é de precisão arbitrária e exata para valores decimais, eliminando o erro de arredondamento binário do IEEE-754. O ORM mapeia essa coluna para `string` (não para `number`), e a camada de repositório converte essa `string` para `Money` na borda do domínio — o domínio nunca importa nada do ORM.
- **Escala fixa:** a coluna `NUMERIC(19,2)` já trunca a escala na própria escrita; um `CHECK (amount = ROUND(amount, 2))` adicional seria redundante por construção e não foi incluído.
- **Quando a moeda é única por entidade:** uma entidade com um único campo monetário cuja moeda não pode divergir da própria entidade (ex.: o saldo de uma wallet, sempre na moeda da própria wallet) usa uma única coluna de moeda compartilhada, nunca uma coluna duplicada por campo — duas colunas que deveriam sempre ser iguais e nunca são comparadas entre si por nenhum `CHECK` cruzado só abrem espaço para drift silencioso, sem nenhum ganho real.
- **Formato da moeda no banco:** `CHAR(3)` garante o comprimento da coluna, mas não garante o conteúdo — um valor mais curto é silenciosamente preenchido com espaço em branco (`'BR'` se torna `'BR '`) em vez de ser rejeitado, o que pode mascarar uma constraint de unicidade composta que inclua essa coluna (duas linhas com a "mesma" moeda, uma truncada, deixam de colidir). Por isso toda coluna de moeda também carrega `CHECK (coluna ~ '^[A-Z]{3}$')`, garantindo exatamente 3 letras maiúsculas, nunca dependendo só do tipo da coluna.

---

## 5. Estratégia de concorrência

**Unidade de concorrência: `walletId`.** Decisão: **lock pessimista por linha (`SELECT ... FOR UPDATE`) dentro da mesma transação SQL que aplica a operação**, combinado com o campo `version` (incrementado apenas quando o saldo muda) como trilha auditável e guarda de segurança secundária.

**Por que pessimista, e não apenas otimista com retry:**
- O cenário obrigatório da seção 8 do desafio (duas apostas de R$ 80 disputando R$ 100 de saldo) precisa resolver-se de forma **determinística e sem retries visíveis ao cliente**. Com optimistic locking puro, a segunda transação detectaria o conflito de `version` apenas no `COMMIT`, precisaria abortar, reler e tentar de novo — sob alta contenção na mesma wallet ("hot wallet"), isso degrada em uma tempestade de retries. Lock pessimista serializa as duas transações na linha da wallet: a segunda transação simplesmente **espera** a primeira liberar o lock, lê o saldo já atualizado, e decide corretamente (rejeita por saldo insuficiente) sem retry.
- O lock é **por linha de wallet**, nunca um lock global — wallets diferentes nunca se bloqueiam entre si (restrição inviolável 6), preservando paralelismo entre jogadores distintos.
- O campo `version` continua existindo e sendo incrementado a cada mudança de saldo, por três razões: (a) é exigido pelo modelo de domínio da especificação; (b) é exposto na API como parte do contrato de resposta; (c) funciona como detector de anomalia caso, por erro de implementação, uma leitura fora da transação travada aconteça — qualquer atualização que não corresponda à `version` esperada é tratada como bug, não como caminho de negócio.

**Por que não apenas "update atômico condicionado" (`UPDATE ... WHERE version = ?`):** essa estratégia funcionaria para o débito/crédito isolado, mas o caso de uso precisa, na mesma transação, decidir *se* a operação é válida (saldo suficiente, referência resolvida, idempotência) antes de decidir o novo valor — o que exige ler o estado da wallet de forma consistente com essas outras leituras (idempotência, referência). O lock pessimista no início da transação cobre esse requisito de forma mais simples do que coordenar múltiplos updates condicionais.

**Transações concorrentes sobre wallets diferentes:** não competem por lock algum — paralelizam livremente, o que é validado pelo teste da seção 13.3.

---

### 5.1 Reconciliação: leitura consistente sem lock pessimista

`POST /wallets/:walletId/reconciliation` lê o saldo materializado da wallet e recalcula o saldo a partir do ledger inteiro **na mesma transação**, aberta com isolamento `REPEATABLE READ`, sem lock pessimista (`FOR UPDATE`). A escolha é deliberada e distinta da seção 5 acima: reconciliação é uma leitura de diagnóstico, não uma operação que decide um efeito financeiro — não há motivo para competir pelo mesmo lock de `walletId` que `ProcessWagerTransactionUseCase` usa, o que a faria esperar (ou fazer esperar) débitos/créditos legítimos sem nenhum ganho correspondente. `REPEATABLE READ` já garante o suficiente para o que a reconciliação precisa: as duas leituras (saldo da wallet, soma do ledger) veem a mesma fotografia consistente do banco, mesmo que outra transação comite um débito/crédito entre elas — sem isso, a reconciliação poderia comparar um saldo contra um ledger de um instante diferente e reportar uma divergência falsa (prejudicando o critério de correção financeira). O trade-off aceito é o inverso do lock pessimista: uma reconciliação concorrente com um débito/crédito pode, em tese, rodar contra um estado que o débito/crédito está no processo de alterar — nesse caso o Postgres simplesmente faz a transação de reconciliação ver o estado anterior ao commit concorrente (semântica normal de `REPEATABLE READ`), nunca um estado parcial ou corrompido.

---

### 5.2 Tempo máximo de espera pelo lock (`lock_timeout`)

O lock pessimista acima serializa corretamente as transações concorrentes sobre a mesma wallet, mas, sem um teto explícito, uma sessão que trava (por bug, por uma conexão perdida sem fechar de forma limpa, ou por um processo morto exatamente entre o `SELECT ... FOR UPDATE` e o `COMMIT`) deixaria toda a fila de espera daquela wallet pendurada indefinidamente — exatamente o tipo de falha que não aparece em nenhum teste de caminho feliz e só se manifesta em produção, na pior hora possível. A mitigação adotada é `SET LOCAL lock_timeout = '5s'` como primeira instrução dentro da mesma transação que executa o `SELECT ... FOR UPDATE` do `ProcessWagerTransactionUseCase` — `LOCAL` restringe o efeito à transação corrente, sem alterar o comportamento de nenhuma outra sessão do pool.

O valor de 5 segundos vem diretamente do cenário de teste obrigatório da seção 8 do desafio: sob 50 requisições simultâneas disputando a mesma wallet, a última da fila espera, no pior caso, pela soma do tempo de processamento das 49 anteriores. Como nenhuma delas faz I/O de rede externo síncrono dentro da transação (seção 2.2), um tempo de processamento individual de até ~100ms sob contenção real já é um limite pessimista para o ambiente de containers local do desafio — o que coloca o pior caso acumulado da fila em torno de 5s (50 × 100ms). Esse valor dá margem confortável ao cenário exigido sem deixar uma requisição genuinamente travada (lock nunca liberado) pendurada por mais tempo do que o necessário. Ao expirar, a transação é abortada pelo próprio Postgres com o erro `55P03`; o caso de uso trata essa condição como falha transitória de infraestrutura (`failureCode = INTERNAL_ERROR`, HTTP `503`, seções 9 e 10), nunca como rejeição de negócio — o provedor é instruído a reenviar, e o reenvio é seguro porque nenhuma escrita chegou a ser commitada.

---

## 6. Idempotência

- **Fonte da verdade:** header `Idempotency-Key`, persistido junto com a transação. Índice único no banco sobre `idempotency_key` — nunca cache em memória.
- **`payloadHash`:** SHA-256 de um JSON canônico (chaves ordenadas alfabeticamente, sem espaços) do subconjunto de campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`). O header e metadados de transporte (IP, timestamps HTTP, `messageId` do SQS) nunca entram no hash — dois canais diferentes (HTTP e SQS) para a mesma operação de negócio devem produzir o mesmo hash.
- **Corrida na criação:** duas requisições simultâneas com a mesma `Idempotency-Key` podem colidir na inserção. A constraint única do banco rejeita a segunda inserção com um erro de violação de unicidade; a aplicação captura esse erro, relê a linha vencedora e retorna o resultado dela como replay — nunca duas aplicações da mesma operação.
- **Conflito:** mesma key, `payloadHash` diferente → HTTP 409, `failureCode = IDEMPOTENCY_CONFLICT`, nunca tratado como replay.
- **Inbox (canal SQS):** chave composta `(consumerName, messageId)`, mesmo princípio — unicidade garantida por constraint, não por verificação em memória antes do insert.

---

### 6.1 Paginação do ledger: cursor assinado com chave simétrica

A consulta paginada do extrato de uma wallet usa cursor opaco (nunca um número de página, que fica inconsistente sob inserções concorrentes) — a mesma preocupação de integridade de um token client-held que a seção 6 já resolve para `Idempotency-Key`/`payloadHash`, aplicada aqui a um valor que o próprio cliente guarda e devolve entre duas chamadas.

**Ordem:** os lançamentos são devolvidos por `createdAt` ascendente — os mais antigos primeiro, desempatando por `id` quando duas linhas têm o mesmo `createdAt`. A ordem inversa (mais recentes primeiro) foi considerada e descartada: um ledger é, por natureza, um registro histórico que se lê como uma linha do tempo que avança, e a ordem ascendente é a que deixa qualquer verificação de consistência (saldo recalculado a partir do ledger, seção 5.1) somar os lançamentos na mesma ordem em que ocorreram, sem precisar inverter a página antes de processá-la.

**Formato:** o cursor é `<payload em base64url>.<assinatura HMAC-SHA256 em base64url>`, onde `payload` é o JSON canônico `{ createdAt, id }` do último lançamento da página anterior. A assinatura é recalculada na decodificação e comparada em tempo constante; um cursor com payload ou assinatura alterados — ou assinado com uma chave diferente — é rejeitado, nunca decodificado silenciosamente para um valor incorreto.

**Chave simétrica, não par de chave pública/privada.** Quem gera o cursor e quem o lê de volta é sempre o mesmo serviço — não há uma segunda parte que precise verificar o cursor sem ter acesso ao segredo (o cenário que justificaria um par assimétrico, como a verificação de um token por um serviço que não o emitiu). Uma única chave simétrica, usada tanto para assinar quanto para verificar, resolve o requisito de "o cliente não pode forjar nem adivinhar um cursor" sem a complexidade de gerenciar um par de chaves.

**Onde a chave vive:** uma variável de ambiente obrigatória, nunca um valor literal no código-fonte. Em desenvolvimento/avaliação local, isso é um valor simples em arquivo de configuração local (fora do controle de versão). **Trade-off aceito, documentado para produção:** um ambiente de produção real não deveria manter esse segredo em um arquivo de configuração — ele pertenceria a um serviço de segredos gerenciado na nuvem (ex.: um secrets manager), lido em runtime; e, além de assinar o cursor (o que só garante que ele não foi adulterado, mas deixa o conteúdo legível por quem decodifica o base64), uma produção real se beneficiaria de também cifrar o payload com essa mesma chave simétrica, escondendo `createdAt`/`id` de quem só pode interceptar o cursor, não forjá-lo. Nenhuma dessas duas melhorias é necessária para o ambiente de avaliação deste desafio, mas ambas ficam registradas aqui para não serem esquecidas caso o serviço evolua para produção real.

---

## 7. Transactional Outbox e Inbox

- Inbox, alteração de wallet, inserção de `wager_transaction`, inserção de `wallet_ledger_entry` e inserção de `outbox_message` ocorrem na **mesma transação SQL** (`EntityManager.transactional()`). Nenhum evento é publicado antes do `COMMIT`.
- **Publicação:** um worker roda em **todas** as instâncias (não há líder eleito) e, periodicamente, executa `SELECT ... FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) FOR UPDATE SKIP LOCKED LIMIT N`. `SKIP LOCKED` garante que múltiplos publishers concorrentes nunca peguem a mesma linha — cada um reivindica um lote disjunto, resolvendo o requisito de "múltiplos publishers concorrentes sem perder nem duplicar indefinidamente" sem precisar de coordenação externa (sem eleição de líder, sem lock distribuído).
- **Uma única transação SQL para o lote inteiro**, não uma transação por mensagem: o `FOR UPDATE SKIP LOCKED` do claim só mantém as linhas do lote travadas enquanto essa transação estiver aberta, então reivindicar o lote inteiro sob uma única transação e só comitar no final (depois de tentar publicar cada mensagem) é o que garante que nenhum outro publisher consiga roubar uma linha já reivindicada antes do `markPublished`/`scheduleRetry` correspondente ser persistido. Dentro desse lote, a falha ao publicar **uma** mensagem nunca aborta as demais: cada mensagem é publicada e seu resultado (sucesso ou retry agendado) é tratado individualmente, isolado por mensagem — só a mensagem que falhou entra em retry, as outras seguem publicadas normalmente no mesmo commit.
- **Falha na publicação:** `scheduleRetry(now)` incrementa `attempts` e calcula `nextAttemptAt` com backoff exponencial (ex.: `base * 2^attempts`, com jitter e teto máximo). Diferente de uma transação em `PENDING_REFERENCE` (seção 8), que pode legitimamente esgotar tentativas e ser rejeitada, um evento de integração já comitado nunca é descartado: as tentativas são infinitas, só o atraso entre elas tem teto.
- **Agendamento:** um loop próprio (`setTimeout` recursivo, nunca `setInterval`) roda em cada instância, sem dependência externa de agendamento — uma rodada só é reagendada depois que a anterior termina (sucesso ou falha), então ciclos nunca se sobrepõem quando uma rodada demora mais que o intervalo configurado.
- **Garantia ao consumidor:** a entrega é *at-least-once* — uma publicação pode, em cenários de crash entre "publicar" e "marcar como publicado", ser reenviada. Isso é uma decisão assumida e documentada: o consumidor externo do evento é responsável por sua própria deduplicação (por `eventId`), exatamente como o próprio desafio pede que esse serviço trate suas próprias entradas.
- **Crash entre commit e publicação (seção 11, cenário obrigatório):** como a outbox já está persistida no mesmo commit da operação de negócio, a morte do processo nesse intervalo não perde o evento — ele continua `published_at IS NULL` e será reivindicado por qualquer instância viva na próxima rodada de polling.

---

## 8. Referências fora de ordem (`PENDING_REFERENCE`)

- `REFUND`/`ROLLBACK` sem a transação referenciada ainda persistida não são rejeitados de imediato: persistem como `PENDING_REFERENCE`.
- Um worker agendado (mesmo padrão de claim via `FOR UPDATE SKIP LOCKED` da outbox) relê periodicamente as transações `PENDING_REFERENCE` cujo `nextAttemptAt` já passou, e tenta resolver a referência.
- **Backoff e limite:** backoff exponencial com teto (ex.: 1min, 2min, 4min, ... até 30min), máximo de **10 tentativas** ou **24 horas** de TTL desde a criação — o que ocorrer primeiro. Esgotado o limite: `REJECTED` com `failureCode = REFERENCE_NOT_FOUND`, e publicação de `WagerTransactionRejected`.
- Justificativa do limite: 24h é tempo suficiente para qualquer atraso realista de rede/provedor entre uma `BET` e seu eventual `REFUND`/`ROLLBACK`; além disso, manter uma transação indefinidamente pendente compromete a auditabilidade e a previsibilidade para o provedor.

### 8.1 `ReferenceResolver`: resolução e validação compartilhadas

Um único serviço resolve e valida qualquer referência por `(providerId, referenceExternalTransactionId)`,
reutilizado tanto pela referência opcional de um resultado vencedor (seção 9) quanto pela referência
obrigatória de uma reversão. Ele devolve um entre cinco resultados, nunca um booleano simples:

- **Resolvida** — a referência existe, já chegou a um estado processado com sucesso, e pertence ao
  mesmo provedor, jogador, wallet, moeda e rodada de quem a referencia.
- **Não encontrada** — não existe nenhuma transação para essa chave, **ou** ela existe mas ainda
  está em processamento (incluindo já estar ela própria esperando por uma referência). Os dois casos
  recebem o mesmo resultado porque, do ponto de vista de quem pergunta, ambos podem ainda se tornar
  válidos mais tarde — é exatamente o sinal que leva à espera descrita acima.
- **Impossível de resolver** — distinto do anterior: a referência existe, mas já chegou a um estado
  final que não é o processamento com sucesso (uma rejeição ou uma falha permanente). Esse estado é
  definitivo — a referência nunca vai se tornar válida reprocessando-a depois. Quem pede a resolução
  deve rejeitar de imediato nesse caso, em vez de entrar na espera da seção acima: esperar backoff e
  tentativas por algo que estruturalmente nunca vai mudar de estado seria apenas desperdício de
  reprocessamento, sem nenhuma chance real de sucesso.
- **Divergente** — a referência existe e processou com sucesso, mas diverge em algum dos cinco
  campos exigidos.
- **Já revertida** — só se aplica quando quem pergunta está, ele mesmo, fazendo uma reversão: já
  existe uma transação do mesmo tipo de reversão apontando para essa mesma referência. Uma reversão
  de um tipo nunca bloqueia a de outro tipo sobre a mesma referência (duas constraints de banco
  separadas, uma por tipo de reversão, sustentam essa garantia mesmo sob inserções concorrentes).
- Quem pergunta decide, a partir de qualquer um desses resultados que não seja "resolvida", qual
  consequência de negócio aplicar — a referência obrigatória de uma reversão espera (estado
  pendente) ou rejeita de imediato dependendo do resultado recebido; a referência opcional de um
  resultado vencedor (seção 9) sempre rejeita de imediato, qualquer que seja o resultado. O serviço
  também não sabe, e não precisa saber, qual tipo de transação cada operação aceita como referência
  válida (uma reversão de um tipo aceita referenciar certos tipos de transação, outra aceita um
  conjunto diferente) — essa checagem continua sendo responsabilidade de quem pergunta.

---

## 9. Taxonomia de `failureCode` (resumo)

| Código | Situação |
|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo suficiente |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | `REFUND`/`ROLLBACK` que levaria o saldo a negativo — distinto do anterior por ser uma falha de consistência de reversão, não de uma aposta legítima sem fundos |
| `REFERENCE_NOT_FOUND` | Referência nunca resolvida após esgotar tentativas de `PENDING_REFERENCE`, ou referência que existe mas já chegou a um estado final que nunca vai se tornar válido (seção 8.1) — nesse segundo caso a rejeição é imediata, sem esperar tentativa alguma |
| `REFERENCE_MISMATCH` | Referência existente, mas de outro provider/player/wallet/moeda/rodada, ou de um tipo/estado que a operação que a referencia não aceita |
| `REFERENCE_ALREADY_REVERSED` | Referência já foi alvo do mesmo tipo de reversão |
| `REFERENCE_AMOUNT_MISMATCH` | Valor da reversão diverge do valor da referência |
| `CURRENCY_MISMATCH` | Moeda da operação diverge da moeda da wallet |
| `IDEMPOTENCY_CONFLICT` | Mesma `Idempotency-Key`, payload diferente |
| `INVALID_PAYLOAD` | Falha de validação de contrato (não é regra de negócio) |
| `INTERNAL_ERROR` | Falha transitória de infraestrutura (retry esperado) |

**Referência opcional de um resultado vencedor.** Um crédito por vitória pode, opcionalmente,
referenciar a aposta da mesma rodada que ele está pagando. Quando essa referência é informada, ela
só é aceita se resolver para uma aposta que já chegou a um estado processado com sucesso (não uma
aposta ainda pendente, nem uma rejeitada, nem outro tipo de operação) e pertencer ao mesmo
provedor, jogador, wallet, moeda e rodada do crédito que a referencia. Qualquer divergência nesses
critérios — incluindo a referência simplesmente não existir — usa `REFERENCE_MISMATCH` e **rejeita
o crédito por completo**: nada é creditado e nenhum lançamento de ledger é criado, mesmo que o
valor do crédito em si seja perfeitamente válido. Ignorar silenciosamente uma referência inválida
foi deliberadamente descartado: um valor correto associado a uma referência incorreta é, na
prática, indistinguível de um erro de integração do provedor (rodada errada, jogador errado), e
esse é exatamente o tipo de inconsistência que a validação existe para detectar — processar mesmo
assim esconderia o problema em vez de expô-lo. Diferente da resolução de referência obrigatória
(seção 8), essa referência é opcional: sua ausência é um caminho normal de processamento, não um
caso de espera — portanto nunca entra em `PENDING_REFERENCE`.

**Moeda é validada mesmo quando a operação não move saldo.** `CURRENCY_MISMATCH` compara a moeda do
valor monetário informado contra a moeda da wallet para **toda** operação financeira, inclusive as
que não produzem nenhum efeito sobre o saldo (ex.: um resultado perdedor, que apenas registra que
a rodada aconteceu). O valor monetário de uma operação é sempre um dado de negócio relevante para
auditoria, independentemente de ele mover o saldo — por isso a consistência de moeda é uma garantia
uniforme do sistema, não uma checagem que só existe como efeito colateral de debitar/creditar.

---

## 10. Mapeamento de status HTTP

| Situação | HTTP |
|---|---|
| Transação nova, `PROCESSED` | `201 Created` |
| Replay idempotente (`idempotentReplay: true`) | `200 OK` |
| Aceita, `PENDING_REFERENCE` | `202 Accepted` |
| Rejeitada por regra de negócio (`REJECTED`) | `422 Unprocessable Entity` |
| Conflito de idempotência (payload divergente) | `409 Conflict` |
| Wallet duplicada (`playerId` + `currency`) | `409 Conflict` |
| Payload inválido | `400 Bad Request` |
| Falha transitória de infraestrutura | `503 Service Unavailable` |
| Recurso inexistente | `404 Not Found` |

Esse mapeamento é aplicado de forma consistente em todos os endpoints, para que o provedor decida automaticamente (reenviar, corrigir payload, ou desistir) sem precisar interpretar texto de mensagem de erro.

**Precedência entre "replay idempotente" e o resultado por baixo.** A linha "Replay idempotente" da tabela acima não é um código à parte com prioridade sobre as demais — ela só descreve a transição de `201` para `200` quando a chamada original terminou em `PROCESSED` (a operação já foi aplicada; a segunda chamada é uma consulta disfarçada de escrita, não uma criação nova). Quando a chamada original terminou `REJECTED`, repetir a mesma `Idempotency-Key` continua respondendo `422` — o mesmo código da primeira vez — e nunca `200`: nada foi "aplicado com sucesso" para justificar um código de sucesso, e forçar `200` faria um consumidor automatizado (que decide só pelo código HTTP, sem ler o corpo) interpretar uma aposta definitivamente rejeitada como se tivesse sido aceita. Em resumo: o status HTTP reflete sempre o resultado de fato da operação (sucesso ou rejeição); o replay é sinalizado apenas pelo campo `idempotentReplay: true` no corpo da resposta, nunca por um código HTTP próprio.

**Mecanismo: hierarquia de erros de domínio + filtro HTTP global.** A tabela acima é uma decisão de modelagem, não só uma convenção documental: existe uma classe base `DomainError`, e toda classe de erro lançada pelo domínio/aplicação que precisa virar uma resposta HTTP específica estende uma de exatamente cinco categorias — uma por linha de rejeição/conflito/ausência/falha da tabela, cada categoria já fixando o status que lhe cabe (validação de payload → `400`; regra de negócio rejeitada → `422`; conflito → `409`; recurso inexistente → `404`; falha transitória de infraestrutura → `503`). Um único filtro de exceções, registrado globalmente, decide o status HTTP só pela categoria da instância capturada — nunca por lógica duplicada em cada endpoint. A categoria é a única fonte do status: nenhum ponto de código decide esse mapeamento por conta própria, exatamente o que torna a tabela acima verdadeira em todos os endpoints, presentes e futuros, sem precisar reconferir cada `throw` manualmente.

O benefício central é que um erro que não se encaixa em nenhuma das cinco categorias — ou seja, um bug genuíno, não uma condição de negócio prevista — nunca é absorvido por acidente como se fosse uma rejeição de negócio: ele cai no caminho padrão do filtro, sempre `500`, sempre logado. Isso separa, estruturalmente, "o provedor fez algo que a regra de negócio rejeita" de "o sistema quebrou de um jeito que ninguém previu" — a mesma distinção que a seção anterior já exige entre rejeição e falha transitória, agora garantida por tipo, não por disciplina de quem escreve cada endpoint.

---

## 11. Autenticação

**Decisão: não implementada no prazo do desafio.** A seção 2 do desafio explicitamente não pontua autenticação, e o prazo de 3 dias foi integralmente direcionado para correção financeira, concorrência, idempotência e mensageria — as áreas que concentram a nota e as falhas eliminatórias.

**Desenho que seria adotado em produção:** integração com um Identity Provider externo via OIDC (Keycloak como primeira escolha, por maturidade e suporte a *client credentials grant*, adequado para chamadas machine-to-machine de provedores de jogos). Um `AuthGuard` no NestJS validaria o JWT emitido pelo IdP e extrairia o `providerId` autenticado das claims do token — nunca do corpo da requisição não verificado.

**Ponto de extensão deixado explícito no código:** um `ProviderIdentityPort` (interface) e um `NoopAuthGuard` que sempre permite a requisição, mas já no formato que um `KeycloakAuthGuard` substituiria sem alterar nenhum controller. Os endpoints de health (`/health/live`, `/health/ready`) e `/metrics` permanecem abertos em qualquer cenário, incluindo um futuro `KeycloakAuthGuard`: nenhum deles carrega dado de negócio do provedor (liveness/readiness da infraestrutura e métricas agregadas, seção 12.3), então exigir o mesmo client credentials grant que protegeria os endpoints de negócio só adicionaria uma dependência de autenticação a um orquestrador/Prometheus que normalmente nem tem a credencial do provedor para apresentar.

**Validação de domínio independente de autenticação:** mesmo sem autenticação, a identidade do provedor contida no payload (HTTP ou SQS) continua sujeita a todas as validações de domínio normais (ex.: resolução de referência por `providerId`) — a ausência de autenticação não relaxa nenhuma regra de negócio.

---

## 12. Observabilidade

A estratégia de observabilidade do sistema foi desenhada para garantir visibilidade total sobre o processamento de transações financeiras distribuídas, identificação proativa de gargalos de concorrência, monitoramento do fluxo assíncrono de mensageria e auditoria sem vazamento de dados sensíveis. A arquitetura cobre quatro pilares:

### 12.1 Logs estruturados e rastreabilidade distribuída

- **Formato:** Logs emitidos exclusivamente como linhas JSON estruturadas (NDJSON) direcionadas para a saída padrão (`stdout`), em conformidade com as boas práticas de microsserviços e sistemas em containers (12-Factor App).
- **Mecanismo e Ferramenta:** Adoção de biblioteca de logging de alta performance (`pino`), integrada ao pipeline do NestJS.
- **Propagação de Contexto (`AsyncLocalStorage`):** Cada operação iniciada no sistema recebe ou extrai um `correlationId` único na borda (seja via cabeçalho HTTP na requisição ou atributo de mensagem no SQS). Esse identificador é propagado de forma transparente por todas as camadas da aplicação (adaptadores, casos de uso, repositórios de banco de dados e publicadores de eventos na outbox) utilizando o mecanismo assíncrono de contexto de execução.
- **Campos de Correlação Obrigatórios:** Todo registro de log associado a uma transação carrega, sempre que aplicável: `correlationId`, `messageId` (quando originado por mensagem), `transactionId`, `walletId`, `providerId`, `timestamp` e `level`.
- **Sanitização e Segurança:** É terminantemente proibido registrar o payload financeiro completo ou dados sensíveis nos logs. Apenas identificadores e metadados de decisão (como status de transição e códigos de erro de negócio) são emitidos, assegurando conformidade de segurança e privacidade.

### 12.2 Monitoramento de filas e Dead-Letter Queue (DLQ)

- **Ambiente Local de Desenvolvimento (SQS Admin):** Para visualização e inspeção de filas no ambiente local sustentado por LocalStack, o ambiente Docker Compose integra uma interface web dedicada (`sqs-admin`). Ela permite acompanhar graficamente a taxa de entrada, mensagens disponíveis, mensagens em voo (*in-flight*) e inspecionar os payloads JSON que trafegam na fila transacional e na fila de eventos de integração.
- **Monitoramento Proativo de Falhas (DLQ):** Mensagens que esgotam o limite máximo de tentativas de recebimento no consumidor são roteadas pelo próprio SQS para a fila de dead-letter (`wager-transactions-dlq.fifo`). O sistema inclui um componente agendador periódico que inspeciona o atributo `ApproximateNumberOfMessages` dessa fila e emite alertas estruturados de alta visibilidade sempre que a contagem for superior a zero. O monitor nunca consome (`ReceiveMessageCommand`) nem remove mensagens da DLQ, preservando integralmente o estado das mensagens para que possam ser auditadas manualmente pela equipe de operações.
- **Ambiente de Produção:** O desenho prevê o direcionamento dessas métricas para serviços gerenciados na nuvem (como métricas e alarmes do CloudWatch), monitorando retenção de DLQ e idade da mensagem mais antiga.

### 12.3 Métricas, Throughput e Latência (Prometheus)

- **Instrumentação e Coleta:** Adoção da biblioteca `prom-client` para coleta de métricas em memória com baixo overhead computacional, expondo os dados através do endpoint HTTP público `GET /metrics` no padrão texto plano universal do Prometheus (`# HELP` e `# TYPE`).
- **Métricas Instrumentadas:**
  - **Throughput e Volume de Transações:** Contador `wager_transactions_total` particionado pelos labels `status` (`PROCESSED`, `REJECTED`, `FAILED`, etc.) e `kind` (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), permitindo calcular o volume de transações por segundo (RPS) por tipo de operação.
  - **Latência de Processamento:** Histograma `wager_transaction_duration_seconds` com buckets calibrados para medir o tempo decorrido desde o recebimento da chamada (HTTP ou SQS) até o encerramento do commit no banco de dados.
  - **Concorrência e Idempotência:**
    - Contador `idempotency_duplicates_total` particionado por canal (HTTP ou Inbox SQS), quantificando chamadas redundantes absorvidas com sucesso.
    - Contador e medidor de tempo `lock_wait_timeout_total` para monitorar contenção de lock pessimista (`SELECT ... FOR UPDATE`) na disputa pela mesma carteira.
  - **Saúde do Fluxo Assíncrono:**
    - Gauge e histograma `outbox_lag_seconds` medindo a defasagem temporal (`now() - occurred_at`) das mensagens pendentes na tabela de outbox, indicando se os workers de publicação estão acompanhando o ritmo das operações financeiras.
    - Contador de mensagens enviadas para a fila de dead-letter (`dlq_messages_total`).
    - Contador `retries_total` medindo as tentativas de reprocessamento realizadas pelo publicador de outbox e pelo resolvedor de referências pendentes.
- **Visualização:** O endpoint é desenhado para ser consumido por um servidor Prometheus que alimenta painéis no Grafana, permitindo visualização de gráficos de throughput em tempo real, latências percentílicas (p50, p95, p99), proporção de sucesso/falha e volume de tráfego assíncrono.

### 12.4 Verificações de integridade (Health Checks)

- **`/health/live` (Liveness):** Responde de forma imediata atestando que a aplicação está em execução e o loop de eventos está ativo, sem consultar dependências externas.
- **`/health/ready` (Readiness):** Verifica a conectividade real e imediata com os componentes de infraestrutura dos quais a operação depende: validação de consulta ao banco de dados PostgreSQL e verificação de comunicação ativa com o serviço de mensageria SQS. Permite que balanceadores de carga e orquestradores retirem a instância de rota caso uma dependência essencial esteja fora do ar.

---

## 13. Testes

- **Unidade:** `Money` (escala, arredondamento, entradas inválidas), invariantes de `Wallet`, regras de cada tipo de operação, conflito de moeda, idempotência com payload divergente — sem tocar banco ou fila.
- **Integração:** PostgreSQL e LocalStack reais via containers (Testcontainers ou Docker Compose dedicado a testes) — migrations/constraints, atomicidade inbox+wallet+ledger+outbox, redelivery, publishers concorrentes, retry/DLQ, recuperação após reinício.
- **Concorrência:** paralelismo real (`Promise.all` com múltiplas chamadas HTTP simultâneas contra instâncias de fato distintas, não chamadas sequenciais disfarçadas) cobrindo os 8 cenários da seção 13 do desafio, com a invariante final `wallet.balance == saldo reconstruído pelo ledger` verificada em todos eles.

---

## 14. Limitações conhecidas e escopo não coberto

- Ledger de partidas dobradas (double-entry com conta espelho) não foi implementado — diferencial opcional pela especificação; não houve sobra de tempo no prazo de 3 dias depois de cobrir o escopo obrigatório (fases 0-3).
- Teste de carga (`bun run test:load`) não foi feito — diferencial opcional pela especificação; mesma razão do item anterior (sem sobra de tempo no prazo de 3 dias).
- Autenticação não implementada — decisão documentada na seção 11.
- Suporte multi-moeda é estrutural no domínio (`Money.currency`), mas o cenário de testes e operação assume moeda única (`BRL`), conforme permitido pela seção 6.1 do desafio.
- Reprocessamento automático de mensagens da fila de dead-letter (`wager-transactions-dlq.fifo`) não é feito — mensagens ali requerem auditoria manual, nunca reentrega automática.
- `REVOKE UPDATE, DELETE` sobre `wallet_ledger_entries` não foi aplicado ao usuário de runtime — a imutabilidade do ledger depende apenas da ausência de código de aplicação que escreva nela (decisão detalhada na seção 1.3).
