// Plugin Seedbox — partie client (JS pur, sans build).
// Les composants sont des objets Vue à `template` string, compilés par le runtimeCompiler
// de l'hôte. Vue vient de l'hôte via api.vue — ne JAMAIS importer vue ici.
// Les réglages sont gérés ICI (ancre plugin.settings.seedbox-qbit) : liste de configs
// multi-providers (qBittorrent, Hydra…), test d'un brouillon SANS l'enregistrer.
export default function setup(api) {
  const { ref, reactive, computed, watch, onMounted, onUnmounted } = api.vue
  const IconSend = api.ui.icons.HardDriveDownload
  const IconCross = api.ui.icons.Shuffle
  const IconCheck = api.ui.icons.Check
  const IconPlus = api.ui.icons.Plus
  const IconPencil = api.ui.icons.Pencil
  const IconTrash = api.ui.icons.Trash2
  const IconStar = api.ui.icons.Star
  const IconSave = api.ui.icons.Save

  // ================= index de la seedbox (matching des releases) =================
  // map = [{hash, name, size, tracker, progress, config}] — agrégé sur TOUTES les configs ;
  // null tant que non chargé/indisponible.
  const map = ref(null)
  let byHash = new Map()
  let byName = new Map()
  let bySize = new Map()
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')
  const isTr4k = (e) => /tr4ker/i.test(e.tracker || '')

  let mapTimer = null
  async function loadMap() {
    try {
      const data = await api.fetch('/map')
      byHash = new Map()
      byName = new Map()
      bySize = new Map()
      for (const e of data) {
        if (e.hash) byHash.set(e.hash, e)
        const n = norm(e.name)
        if (n) byName.set(n, [...(byName.get(n) || []), e])
        if (e.size) bySize.set(e.size, [...(bySize.get(e.size) || []), e])
      }
      map.value = data
      scheduleMap(60_000)
    } catch (e) {
      map.value = null
      // 400 = pas configuré → inutile d'insister ; sinon (seedbox down…) on retente plus tard
      if ((e?.status || e?.statusCode) !== 400) scheduleMap(300_000)
    }
  }
  function scheduleMap(ms) { clearTimeout(mapTimer); mapTimer = setTimeout(loadMap, ms) }
  loadMap()

  /** Statut d'une release vis-à-vis de la seedbox :
   *  'seedbox' = ce torrent y est déjà (hash identique, ou candidat via tracker tr4ker)
   *  'cross'   = même release présente via un AUTRE tracker → cross-seed possible
   *  Candidats = même nom normalisé OU même taille EXACTE à l'octet. La taille exacte est
   *  indispensable pour la LISTE : elle n'expose pas info_hash, et le nom affiché par le
   *  tracker est souvent décoré (« … (Titre français) ») ≠ nom du torrent côté client. */
  function matchFor(t) {
    if (!map.value || !t) return { status: null }
    const h = String(t.info_hash || '').toLowerCase()
    if (h && byHash.has(h)) return { status: 'seedbox', e: byHash.get(h) }
    const sz = t.size_bytes || 0
    const cands = [...(byName.get(norm(t.name)) || []), ...(sz ? bySize.get(sz) || [] : [])]
    if (!cands.length) return { status: null }
    const fromTr4k = cands.find(isTr4k)
    if (fromTr4k) return { status: 'seedbox', e: fromTr4k }
    // autre tracker : cross-seed si taille exacte, ou nom identique avec taille proche (±2 %)
    const close = cands.find((e) => e.size === sz || !sz || !e.size || Math.abs(e.size - sz) / Math.max(e.size, sz) <= 0.02)
    return close ? { status: 'cross', e: close } : { status: null }
  }

  // ================= badge « SEEDBOX » (lignes + fiche) =================
  const SeedboxBadge = {
    props: ['ctx'],
    template: `<span v-if="on" class="badge b-cat" title="Cette release est déjà sur ta seedbox">SEEDBOX</span>`,
    setup(props) {
      const on = computed(() => matchFor(props.ctx).status === 'seedbox')
      return { on }
    },
  }
  api.ui.registerSlot('torrent.row.badges', SeedboxBadge)
  api.ui.registerSlot('torrent.detail.badges', SeedboxBadge)

  // en-tête d'un groupe « Par œuvre » : badge si AU MOINS une release du groupe est sur la seedbox
  api.ui.registerSlot('torrent.group.badges', {
    props: ['ctx'], // ctx = groupe { releases[], rep, count… }
    template: `<span v-if="n" class="badge b-cat" :title="n + ' release(s) de ce groupe déjà sur ta seedbox'">SEEDBOX{{ n > 1 ? ' ×' + n : '' }}</span>`,
    setup(props) {
      const n = computed(() => (props.ctx?.releases || []).filter((t) => matchFor(t).status === 'seedbox').length)
      return { n }
    },
  })

  // ================= bouton d'action : envoyer / cross-seed / déjà là =================
  const SendBtn = {
    props: { ctx: Object, wide: Boolean },
    components: { IconSend, IconCross, IconCheck },
    template: `
      <span v-if="state === 'seedbox'" class="iconbtn" style="cursor:default; color:var(--accent); border-color:transparent"
            :title="'Déjà sur la seedbox'">
        <IconCheck :size="15" /><template v-if="wide"> Sur la seedbox</template>
      </span>
      <button v-else-if="state === 'cross'" class="iconbtn" :disabled="busy"
              :style="wide ? 'display:inline-flex; gap:7px; align-items:center; padding:8px 16px' : ''"
              title="Cross-seed : cette release est sur la seedbox via un autre tracker — ajouter la version TR4KER sur les mêmes fichiers"
              @click="crossSeed">
        <span v-if="busy" class="spin" /><IconCross v-else :size="15" />
        <template v-if="wide"> Cross-seed</template>
      </button>
      <button v-else class="iconbtn" :disabled="busy"
              :style="wide ? 'display:inline-flex; gap:7px; align-items:center; padding:8px 16px' : ''"
              title="Envoyer à la seedbox" @click="send">
        <span v-if="busy" class="spin" /><IconSend v-else :size="15" />
        <template v-if="wide"> Envoyer à la seedbox</template>
      </button>`,
    setup(props) {
      const busy = ref(false)
      const local = ref('') // devient 'seedbox' après un envoi/cross réussi (avant le refresh du /map)
      const state = computed(() => local.value || matchFor(props.ctx).status)
      async function send() {
        busy.value = true
        try {
          await api.fetch('/add', { method: 'POST', body: { slug: props.ctx.slug } })
          local.value = 'seedbox'
          api.ui.toast('Seedbox', `« ${props.ctx.name || props.ctx.slug} » envoyé à la seedbox`)
          loadMap()
        } catch (e) {
          api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      async function crossSeed() {
        busy.value = true
        try {
          const target = matchFor(props.ctx).e
          const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: props.ctx.slug, target_hash: target.hash, config: target.config } })
          local.value = 'seedbox'
          api.ui.toast('Cross-seed lancé', `Ajouté dans ${r.savepath} — le client vérifie les fichiers existants puis seed`)
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      return { busy, state, send, crossSeed }
    },
  }
  api.ui.registerSlot('torrent.row.actions', SendBtn)
  api.ui.registerSlot('torrent.detail.actions', {
    props: ['ctx'],
    components: { SendBtn },
    template: `<SendBtn :ctx="ctx" :wide="true" />`,
  })

  // ================= doublons du profil : basculer la seedbox sur la version conservée =================
  // ctx = un doublon {retired_slug/name, kept_slug/name, kept_seeders, size_bytes} (ancre
  // profile.duplicates.actions). Retirée et conservée ont la MÊME taille : c'est le nom
  // normalisé qui départage laquelle des deux est réellement sur la seedbox.
  api.ui.registerSlot('profile.duplicates.actions', {
    props: { ctx: Object },
    components: { IconSend, IconCross, IconCheck },
    template: `
      <span v-if="state === 'done'" class="iconbtn" style="cursor:default; color:var(--accent); border-color:transparent"
            title="La version conservée est déjà sur ta seedbox — rien à faire">
        <IconCheck :size="15" />
      </span>
      <button v-else-if="state === 'cross'" class="iconbtn" :disabled="busy"
              title="La version retirée est sur ta seedbox : cross-seed de la version conservée sur les mêmes fichiers (re-vérification puis seed, aucun re-téléchargement)"
              @click="cross">
        <span v-if="busy" class="spin" /><IconCross v-else :size="15" />
      </button>
      <button v-else-if="state === 'send'" class="iconbtn" :disabled="busy"
              title="Envoyer la version conservée à la seedbox" @click="send">
        <span v-if="busy" class="spin" /><IconSend v-else :size="15" />
      </button>`,
    setup(props) {
      const busy = ref(false)
      const local = ref('') // 'done' après une action réussie, avant le refresh du /map
      const keptHit = () => (byName.get(norm(props.ctx?.kept_name)) || [])[0]
      // cible du cross-seed : la retirée par son nom, sinon n'importe quel torrent de taille EXACTE
      const target = () => (byName.get(norm(props.ctx?.retired_name)) || [])[0]
        || (bySize.get(props.ctx?.size_bytes) || [])[0]
      const state = computed(() => {
        if (local.value) return local.value
        if (!map.value || !props.ctx) return '' // seedbox non configurée → rien
        if (keptHit()) return 'done'
        return target() ? 'cross' : 'send'
      })
      async function cross() {
        busy.value = true
        try {
          const t = target()
          const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: props.ctx.kept_slug, target_hash: t.hash, config: t.config } })
          local.value = 'done'
          api.ui.toast('Cross-seed lancé', `Version conservée ajoutée dans ${r.savepath} — le client vérifie puis seed`)
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      async function send() {
        busy.value = true
        try {
          await api.fetch('/add', { method: 'POST', body: { slug: props.ctx.kept_slug } })
          local.value = 'done'
          api.ui.toast('Seedbox', `« ${props.ctx.kept_name} » envoyé à la seedbox`)
          loadMap()
        } catch (e) {
          api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      return { busy, state, cross, send }
    },
  })

  // ================= toggle « Masquer seedbox » (barre d'outils de la liste) =================
  const HIDE_KEY = 'tr4kui.seedbox-qbit.hide'
  const hideSb = ref(false)
  try { hideSb.value = localStorage.getItem(HIDE_KEY) === '1' } catch {}
  watch(hideSb, (v) => { try { localStorage.setItem(HIDE_KEY, v ? '1' : '0') } catch {} })

  api.ui.registerSlot('torrent.list.toolbar', {
    components: { IconSend },
    template: `
      <label v-if="ready" class="sw" :class="{ on: hideSb }"
             title="Masquer les releases déjà présentes sur la seedbox" @click="hideSb = !hideSb">
        <span class="track" /> <IconSend :size="13" /> Masquer seedbox
      </label>`,
    setup() {
      const ready = computed(() => !!map.value)
      return { ready, hideSb }
    },
  })

  // filtre de liste : lu par le computed `items` d'index.vue → réactif à hideSb et au /map
  api.filters.addFilter('torrent.list.items', (list) => {
    if (!hideSb.value || !map.value) return list
    return list.filter((t) => matchFor(t).status !== 'seedbox')
  })

  // ================= réglages : gestionnaire de configurations (multi-providers) =================
  // Remplace le formulaire standard de l'hôte (plugin.json ne déclare plus de champs).
  // « Tester » éprouve le BROUILLON via POST /configs/test — rien n'est enregistré.
  api.ui.registerSlot('plugin.settings.seedbox-qbit', {
    components: { IconPlus, IconPencil, IconTrash, IconStar, IconSave, IconCheck },
    template: `
      <div v-if="loading" class="empty"><span class="spin" /></div>
      <div v-else style="display:flex; flex-direction:column; gap:12px; max-width:560px">

        <!-- liste des configs -->
        <div v-for="c in configs" :key="c.id"
             style="display:flex; gap:10px; align-items:center; padding:9px 12px; border:1px solid var(--line); border-radius:10px">
          <div style="min-width:0; flex:1">
            <b style="font-size:13px">{{ c.name }}</b>
            <span class="badge" style="margin-left:8px">{{ providerLabel(c.provider) }}</span>
            <span v-if="c.id === defaultId" class="badge b-cat" style="margin-left:6px" title="Config utilisée par défaut pour les envois">défaut</span>
            <div class="muted mono" style="font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ c.values.url }}</div>
          </div>
          <button v-if="c.id !== defaultId" class="iconbtn" title="Utiliser par défaut" @click="setDefault(c)"><IconStar :size="14" /></button>
          <button class="iconbtn" title="Modifier" @click="edit(c)"><IconPencil :size="14" /></button>
          <button class="iconbtn" title="Supprimer" @click="del(c)"><IconTrash :size="14" /></button>
        </div>

        <button v-if="!editing" class="ghost small" style="align-self:flex-start" @click="add">
          <IconPlus :size="14" /> Ajouter une configuration
        </button>

        <!-- formulaire (ajout / édition) -->
        <form v-if="editing" style="display:flex; flex-direction:column; gap:11px; padding:13px 14px; border:1px solid var(--line); border-radius:10px"
              @submit.prevent="save">
          <label style="display:flex; flex-direction:column; gap:5px">
            <span style="font-size:12px">Nom *</span>
            <input v-model="editing.name" type="text" placeholder="Ma seedbox" autocomplete="off" />
          </label>
          <label style="display:flex; flex-direction:column; gap:5px">
            <span style="font-size:12px">Client torrent</span>
            <select v-model="editing.provider">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label v-for="f in fieldsOf(editing.provider)" :key="f.key" style="display:flex; flex-direction:column; gap:5px">
            <span style="font-size:12px">{{ f.label }}<template v-if="f.required"> *</template></span>
            <select v-if="f.type === 'select'" v-model="editing.values[f.key]">
              <option v-for="o in f.options || []" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input v-else v-model="editing.values[f.key]"
                   :type="f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'"
                   :placeholder="f.placeholder" autocomplete="off" />
            <span v-if="f.help" class="muted" style="font-size:11px">{{ f.help }}</span>
          </label>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:2px">
            <button type="button" class="ghost small" :disabled="!!busy" title="Teste ce brouillon sans rien enregistrer" @click="test">
              <span v-if="busy === 'test'" class="spin" /> Tester
            </button>
            <button type="button" class="ghost small" :disabled="!!busy" title="Teste puis enregistre si la connexion répond" @click="testAndSave">
              <span v-if="busy === 'testsave'" class="spin" /><IconCheck v-else :size="13" /> Tester et enregistrer
            </button>
            <button type="submit" class="primary small" :disabled="!!busy">
              <span v-if="busy === 'save'" class="spin" /><IconSave v-else :size="13" /> Enregistrer
            </button>
            <button type="button" class="ghost small" :disabled="!!busy" @click="editing = null">Annuler</button>
            <span v-if="result" :style="result.ok ? 'color:var(--accent); font-size:12.5px' : 'color:#ff6b6b; font-size:12.5px'">
              {{ result.ok ? '● Connecté' + (result.version ? ' — ' + result.version : '') : '○ ' + result.error }}
            </span>
          </div>
        </form>
      </div>`,
    setup() {
      const loading = ref(true)
      const providers = ref([])
      const configs = ref([])
      const defaultId = ref('')
      const editing = ref(null)
      const busy = ref('') // '' | 'test' | 'save' | 'testsave'
      const result = ref(null)

      const providerLabel = (id) => providers.value.find((p) => p.id === id)?.label || id
      const fieldsOf = (id) => providers.value.find((p) => p.id === id)?.fields || []

      async function load() {
        try {
          const [p, c] = await Promise.all([api.fetch('/providers'), api.fetch('/configs')])
          providers.value = p
          configs.value = c.configs
          defaultId.value = c.defaultConfig
        } catch (e) {
          api.ui.toast('Seedbox : réglages indisponibles', e?.data?.statusMessage || e?.message)
        }
        loading.value = false
      }
      load()

      function withDefaults(providerId, values = {}) {
        const v = { ...values }
        for (const f of fieldsOf(providerId)) if (!(f.key in v)) v[f.key] = f.default ?? (f.type === 'boolean' ? false : '')
        return v
      }
      function add() {
        const provider = providers.value[0]?.id || 'qbittorrent'
        editing.value = reactive({ name: '', provider, values: withDefaults(provider) })
        result.value = null
      }
      function edit(c) {
        editing.value = reactive({ id: c.id, name: c.name, provider: c.provider, values: withDefaults(c.provider, { ...c.values }) })
        result.value = null
      }
      // changement de provider : on complète les défauts de ses champs (l'URL saisie est conservée)
      watch(() => editing.value?.provider, (id) => {
        if (id && editing.value) editing.value.values = withDefaults(id, editing.value.values)
      })

      async function test() {
        busy.value = busy.value || 'test'
        result.value = null
        try {
          result.value = await api.fetch('/configs/test', { method: 'POST', body: { config: { ...editing.value } } })
        } catch (e) {
          result.value = { ok: false, error: e?.data?.statusMessage || e?.message || 'Erreur' }
        }
        if (busy.value === 'test') busy.value = ''
        return !!result.value?.ok
      }
      async function save() {
        busy.value = busy.value || 'save'
        try {
          const r = await api.fetch('/configs/save', { method: 'POST', body: { config: { ...editing.value } } })
          defaultId.value = r.defaultConfig
          editing.value = null
          api.ui.toast('Seedbox', `Configuration « ${r.config.name} » enregistrée`)
          await load()
          loadMap()
        } catch (e) {
          api.ui.toast('Seedbox : échec de l’enregistrement', e?.data?.statusMessage || e?.message)
        }
        busy.value = ''
      }
      async function testAndSave() {
        busy.value = 'testsave'
        if (await test()) await save()
        else busy.value = ''
      }
      async function setDefault(c) {
        try {
          const r = await api.fetch('/configs/default', { method: 'POST', body: { id: c.id } })
          defaultId.value = r.defaultConfig
        } catch (e) { api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message) }
      }
      async function del(c) {
        if (!confirm(`Supprimer la configuration « ${c.name} » ?`)) return
        try {
          const r = await api.fetch('/configs/delete', { method: 'POST', body: { id: c.id } })
          defaultId.value = r.defaultConfig
          if (editing.value?.id === c.id) editing.value = null
          await load()
          loadMap()
        } catch (e) { api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message) }
      }

      return { loading, providers, configs, defaultId, editing, busy, result, providerLabel, fieldsOf, add, edit, test, save, testAndSave, setDefault, del }
    },
  })

  // ================= page /p/seedbox-qbit : suivi + cross-seed + upload =================
  const IconUp = api.ui.icons.Upload
  const Page = {
    components: { IconSend, IconCross, IconCheck, IconUp },
    template: `
      <div style="padding-top:16px; display:flex; flex-direction:column; gap:14px">
        <h1 style="margin:0; font-size:19px; display:flex; gap:9px; align-items:center"><IconSend :size="20" /> Seedbox</h1>

        <div v-if="!configured" class="pill-note">
          Seedbox non configurée : ajoute une configuration dans la page <b>Plugins → Seedbox → Réglages</b>.
        </div>

        <template v-else>
          <!-- onglets Suivi / Cross-seed -->
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <button class="chip" :class="{ on: tab === 'suivi' }" @click="tab = 'suivi'">Suivi</button>
            <button class="chip" :class="{ on: tab === 'cross' }" @click="openCross">
              Cross-seed<template v-if="crossable"> · {{ crossable }}</template>
            </button>
          </div>

          <!-- ============ onglet CROSS-SEED : seedbox → tracker ============ -->
          <template v-if="tab === 'cross'">
            <div class="pill-note">
              Repère les torrents <b>terminés</b> de ta seedbox qui existent aussi sur TR4KER (venus d'un autre
              tracker) : un clic ajoute la version TR4KER sur les mêmes fichiers — le client vérifie puis seed,
              sans rien retélécharger.
            </div>

            <div v-if="scanErr" class="pill-note" style="color:#ff6b6b">○ {{ scanErr }}</div>
            <div v-else-if="!scan" class="card" style="display:flex; gap:14px; align-items:center">
              <span class="muted"><span class="spin" /> Analyse de la seedbox…</span>
            </div>

            <template v-if="scan">
              <div class="card" style="display:flex; gap:14px; align-items:center; flex-wrap:wrap">
                <span class="muted" style="font-size:12.5px">
                  {{ scan.items.length }} torrent(s) hors TR4KER — analysé {{ fmtAgo(scan.scanned_at) }}
                </span>
                <span style="flex:1" />
                <button v-if="countsC.cross" class="primary small" :disabled="scanning || !!bulk" @click="crossAll">
                  <span v-if="bulk" class="spin" /><IconCross v-else :size="13" />
                  {{ bulk ? bulk.done + ' / ' + bulk.total + fails(bulk) : 'Tout cross-seeder (' + countsC.cross + ')' }}
                </button>
                <button class="ghost small" :disabled="scanning || !!bulk" @click="doScan(true)">
                  <span v-if="scanning" class="spin" /> Réanalyser
                </button>
              </div>

              <div v-for="c in scan.configs.filter((x) => !x.ok)" :key="c.id" class="pill-note" style="color:#ff6b6b">
                ○ Config « {{ c.name }} » injoignable ({{ c.error }}) — ses torrents ne sont pas dans l'analyse.
              </div>
              <div v-if="scan.truncated" class="pill-note">
                Beaucoup de torrents : seuls les 400 plus récents ont été analysés.
              </div>

              <!-- filtres par statut -->
              <div style="display:flex; gap:8px; flex-wrap:wrap">
                <button v-for="f in FILTERS" :key="f.id" class="chip" :class="{ on: filter === f.id }" @click="filter = f.id">
                  {{ f.label }} · {{ f.count() }}
                </button>
              </div>

              <div class="tablewrap">
                <table>
                  <thead><tr><th>Nom</th><th v-if="multiCfg">Config</th><th>Tracker actuel</th><th class="num">Taille</th><th class="num">Seeders TR4KER</th><th style="width:1%"></th></tr></thead>
                  <tbody>
                    <tr v-for="t in visible" :key="t.config + t.hash">
                      <td class="grow" style="font-size:12.5px; max-width:460px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
                          :title="t.name + (t.match && t.match.name !== t.name ? '\\n→ sur TR4KER : ' + t.match.name : '')">{{ t.name }}</td>
                      <td v-if="multiCfg"><span class="badge">{{ t.config_name }}</span></td>
                      <td class="mono muted" style="font-size:11.5px" :title="t.tracker">{{ trackerHost(t.tracker) }}</td>
                      <td class="num mono">{{ fmtBytes(t.size) }}</td>
                      <td class="num mono">{{ t.match ? t.match.seeders : '—' }}</td>
                      <td style="white-space:nowrap">
                        <button v-if="t.status === 'cross' || t.status === 'near'" class="iconbtn" :disabled="rowBusy[t.config + t.hash] || !!bulk"
                                :title="t.status === 'near'
                                  ? 'Taille légèrement différente (' + fmtBytes(t.match.size_bytes) + ' sur TR4KER) : le client retéléchargera les morceaux manquants'
                                  : 'Cross-seed : ajouter la version TR4KER sur les mêmes fichiers'"
                                @click="crossOne(t)">
                          <span v-if="rowBusy[t.config + t.hash]" class="spin" /><IconCross v-else :size="15" />
                          {{ t.status === 'near' ? 'Cross-seed ≈' : 'Cross-seed' }}
                        </button>
                        <span v-else-if="t.status === 'done'" class="badge b-cat" title="La version TR4KER est déjà sur ta seedbox"><IconCheck :size="11" /> seedé</span>
                        <span v-else-if="t.status === 'same'" class="badge b-cat" title="Ce torrent a le même info_hash que celui du tracker — il seede déjà (ou seederait) sur TR4KER tel quel">identique</span>
                        <span v-else-if="t.status === 'diff'" class="badge" :title="'Même nom mais ' + fmtBytes(t.match.size_bytes) + ' sur TR4KER : sûrement une autre version'">autre version</span>
                        <span v-else-if="t.status === 'uploaded'" class="badge b-cat" title="Uploadé sur TR4KER — en attente de validation par le staff">uploadé ✓</span>
                        <button v-else class="iconbtn" :disabled="!!bulk"
                                title="Cette release est introuvable sur TR4KER : l'uploader (formulaire pré-rempli, .torrent reconstruit automatiquement)"
                                @click="openUpload(t)">
                          <IconUp :size="15" /> Uploader
                        </button>
                      </td>
                    </tr>
                    <tr v-if="!visible.length">
                      <td :colspan="multiCfg ? 6 : 5" class="empty">
                        {{ scan.items.length ? 'Rien dans cette catégorie.' : 'Aucun torrent terminé venant d\\'un autre tracker — rien à cross-seeder.' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="filter === 'absent' && countsC.absent" class="muted" style="margin:0; font-size:12px">
                Ces releases ne sont pas sur TR4KER : le bouton Uploader reconstruit le .torrent
                (private + source TR4KER), pré-remplit la fiche et remet le torrent en seed après l'envoi.
              </p>
            </template>

            <!-- ============ modale d'upload ============ -->
            <div v-if="up" style="position:fixed; inset:0; z-index:90; background:rgba(0,0,0,.55); display:flex; align-items:flex-start; justify-content:center; overflow:auto; padding:30px 14px"
                 @click.self="up = null">
              <div class="card" style="width:min(640px, 100%); display:flex; flex-direction:column; gap:12px">
                <b style="font-size:15px; display:flex; gap:8px; align-items:center"><IconUp :size="16" /> Uploader sur TR4KER</b>
                <div class="mono muted" style="font-size:11.5px; word-break:break-all">{{ up.item.name }}</div>

                <div v-if="up.loading" class="empty"><span class="spin" /> Préparation (.torrent exporté et reconstruit)…</div>
                <div v-else-if="up.err" class="pill-note" style="color:#ff6b6b">○ {{ up.err }}</div>

                <template v-else-if="up.done">
                  <div class="pill-note">
                    ✓ Uploadé — le torrent est <b>en attente de validation</b> par le staff.
                    <template v-if="up.result.seeded"> Il a été remis en seed sur la seedbox.</template>
                  </div>
                  <div style="display:flex; gap:10px">
                    <button v-if="up.result.slug" class="primary small" @click="goFiche(up.result.slug)">Voir la fiche</button>
                    <button class="ghost small" @click="up = null">Fermer</button>
                  </div>
                </template>

                <template v-else-if="up.prep">
                  <div v-if="up.prep.existing" class="pill-note" style="color:var(--accent)">
                    Ce FICHIER est déjà sur TR4KER (« {{ up.prep.existing.name || up.prep.existing.slug }} ») —
                    inutile d'uploader un doublon : cross-seede la version existante.
                    <button class="ghost small" style="margin-left:8px" :disabled="up.busy" @click="crossExisting">
                      <span v-if="up.busy" class="spin" /><IconCross v-else :size="13" /> Cross-seed
                    </button>
                  </div>

                  <form v-else style="display:flex; flex-direction:column; gap:11px" @submit.prevent="submitUpload">
                    <label style="display:flex; flex-direction:column; gap:5px">
                      <span style="font-size:12px">Nom de la release *</span>
                      <input v-model="up.form.name" type="text" required />
                    </label>
                    <div style="display:flex; gap:10px; flex-wrap:wrap">
                      <label style="display:flex; flex-direction:column; gap:5px; flex:1; min-width:170px">
                        <span style="font-size:12px">Catégorie *</span>
                        <select v-model="up.form.category_slug" required>
                          <option value="" disabled>— choisir —</option>
                          <option v-for="c in parentCats" :key="c.slug" :value="c.slug">{{ c.name }}</option>
                        </select>
                      </label>
                      <label style="display:flex; flex-direction:column; gap:5px; flex:1; min-width:170px">
                        <span style="font-size:12px">Sous-catégorie</span>
                        <select v-model="up.form.subcategory_slug">
                          <option value="">—</option>
                          <option v-for="c in subCats" :key="c.slug" :value="c.slug">{{ c.name }}</option>
                        </select>
                      </label>
                      <label style="display:flex; flex-direction:column; gap:5px; width:110px">
                        <span style="font-size:12px">Année</span>
                        <input v-model="up.form.year" type="text" inputmode="numeric" />
                      </label>
                    </div>

                    <div v-if="up.prep.tmdb.length" style="display:flex; flex-direction:column; gap:6px">
                      <span style="font-size:12px">Œuvre TMDB (pose l'affiche et la fiche)</span>
                      <div style="display:flex; gap:8px; flex-wrap:wrap">
                        <button v-for="r in up.prep.tmdb" :key="r.id" type="button" class="chip" :class="{ on: up.form.tmdb_id === r.id }"
                                @click="pickTmdb(r)">
                          {{ r.title }}<template v-if="r.year"> ({{ r.year }})</template>
                        </button>
                        <button type="button" class="chip" :class="{ on: !up.form.tmdb_id }" @click="pickTmdb(null)">Aucune</button>
                      </div>
                    </div>

                    <label style="display:flex; flex-direction:column; gap:5px">
                      <span style="font-size:12px">Tags (séparés par des virgules)</span>
                      <input v-model="up.form.tags" type="text" :placeholder="tagHint" />
                    </label>
                    <label style="display:flex; flex-direction:column; gap:5px">
                      <span style="font-size:12px">Présentation (BBCode)</span>
                      <textarea v-model="up.form.presentation" rows="6" class="mono" style="font-size:12px" />
                    </label>
                    <label style="display:flex; flex-direction:column; gap:5px">
                      <span style="font-size:12px">NFO / MediaInfo (optionnel mais apprécié du staff)</span>
                      <textarea v-model="up.form.nfo" rows="3" class="mono" style="font-size:12px" placeholder="Colle ici la sortie mediainfo si tu l'as" />
                    </label>
                    <div style="display:flex; gap:16px; flex-wrap:wrap">
                      <label class="sw" :class="{ on: up.form.seed_after }" @click="up.form.seed_after = !up.form.seed_after">
                        <span class="track" /> Remettre en seed après l'upload
                      </label>
                      <label class="sw" :class="{ on: up.form.is_anonymous }" @click="up.form.is_anonymous = !up.form.is_anonymous">
                        <span class="track" /> Upload anonyme
                      </label>
                    </div>
                    <div style="display:flex; gap:10px; align-items:center">
                      <button type="submit" class="primary small" :disabled="up.busy">
                        <span v-if="up.busy" class="spin" /><IconUp v-else :size="13" /> Uploader sur TR4KER
                      </button>
                      <button type="button" class="ghost small" :disabled="up.busy" @click="up = null">Annuler</button>
                      <span class="muted mono" style="font-size:11px; margin-left:auto">{{ fmtBytes(up.prep.size) }} · {{ up.prep.file_count }} fichier(s)</span>
                    </div>
                  </form>
                </template>
              </div>
            </div>
          </template>

          <!-- ============ onglet SUIVI (existant) ============ -->
          <template v-else>
          <!-- sélecteur de config quand il y en a plusieurs -->
          <div v-if="configs.length > 1" style="display:flex; gap:8px; flex-wrap:wrap">
            <button v-for="c in configs" :key="c.id" class="chip" :class="{ on: c.id === selected }" @click="select(c.id)">
              {{ c.name }}
            </button>
          </div>

          <div class="card" style="display:flex; gap:18px; align-items:center; flex-wrap:wrap">
            <span v-if="status && status.ok" style="color:var(--accent)">● Connecté</span>
            <span v-else-if="status" style="color:#ff6b6b">○ {{ status.error }}</span>
            <span v-else class="muted"><span class="spin" /> Connexion…</span>
            <template v-if="status && status.ok">
              <span class="mono muted" style="font-size:12px">↓ {{ fmtSpeed(status.dl) }}</span>
              <span class="mono muted" style="font-size:12px">↑ {{ fmtSpeed(status.up) }}</span>
              <span class="mono muted" style="font-size:12px">{{ torrents.length }} torrent(s)</span>
            </template>
            <span style="flex:1" />
            <button class="ghost small" :disabled="loading" @click="refresh">Actualiser</button>
          </div>

          <div v-if="status && status.ok" class="tablewrap">
            <table>
              <thead><tr><th>Nom</th><th class="num">Progression</th><th>État</th><th class="num">↓</th><th class="num">↑</th><th class="num">Ratio</th><th class="num">Taille</th></tr></thead>
              <tbody>
                <tr v-for="t in torrents" :key="t.hash">
                  <td class="grow" style="font-size:12.5px; max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="t.name">{{ t.name }}</td>
                  <td class="num mono">{{ Math.round((t.progress || 0) * 100) }} %</td>
                  <td><span class="badge" :class="stateClass(t.state)">{{ stateLabel(t.state) }}</span></td>
                  <td class="num mono">{{ fmtSpeed(t.dlspeed) }}</td>
                  <td class="num mono">{{ fmtSpeed(t.upspeed) }}</td>
                  <td class="num mono">{{ (t.ratio || 0).toFixed(2) }}</td>
                  <td class="num mono">{{ fmtBytes(t.size) }}</td>
                </tr>
                <tr v-if="!torrents.length"><td colspan="7" class="empty">Aucun torrent sur cette seedbox.</td></tr>
              </tbody>
            </table>
          </div>
          </template>
        </template>
      </div>`,
    setup() {
      const torrents = ref([])
      const status = ref(null)
      const loading = ref(false)
      const configured = ref(true)
      const configs = ref([])
      const selected = ref('')
      let timer = null

      // ---- onglet cross-seed ----
      const tab = ref('suivi')
      const scan = ref(null) // réponse de GET /cross-scan
      const scanning = ref(false)
      const scanErr = ref('')
      const filter = ref('action')
      const rowBusy = reactive({})
      const bulk = ref(null) // { done, total, errors } pendant « Tout cross-seeder »

      const countsC = computed(() => {
        const c = { cross: 0, near: 0, done: 0, same: 0, diff: 0, absent: 0, uploaded: 0 }
        for (const t of scan.value?.items || []) c[t.status] = (c[t.status] || 0) + 1
        return c
      })
      const crossable = computed(() => countsC.value.cross + countsC.value.near || 0)
      const multiCfg = computed(() => (scan.value?.configs || []).length > 1)
      const FILTERS = [
        { id: 'action', label: 'À cross-seeder', count: () => countsC.value.cross + countsC.value.near },
        { id: 'done', label: 'Déjà seedés', count: () => countsC.value.done + countsC.value.same },
        { id: 'diff', label: 'Autres versions', count: () => countsC.value.diff },
        { id: 'absent', label: 'Absents du tracker', count: () => countsC.value.absent + countsC.value.uploaded },
      ]
      const GROUPS = { action: ['cross', 'near'], done: ['done', 'same'], diff: ['diff'], absent: ['absent', 'uploaded'] }
      const visible = computed(() => (scan.value?.items || []).filter((t) => GROUPS[filter.value].includes(t.status)))

      async function doScan(refresh) {
        scanning.value = true
        scanErr.value = ''
        try {
          scan.value = await api.fetch('/cross-scan', { query: refresh ? { refresh: 1 } : {} })
        } catch (e) {
          if ((e?.status || e?.statusCode) === 400) configured.value = false
          scanErr.value = e?.data?.statusMessage || e?.message || 'Erreur inconnue'
        }
        scanning.value = false
      }
      function openCross() {
        tab.value = 'cross'
        if (!scan.value && !scanning.value) doScan(false)
      }

      // cross-seed d'une ligne — utilisé seul (confirm sur 'near') et par le lot
      async function crossRaw(t) {
        const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: t.match.slug, target_hash: t.hash, config: t.config } })
        t.status = 'done'
        return r
      }
      async function crossOne(t) {
        if (t.status === 'near' && !confirm(
          `La taille diffère légèrement (${fmtBytes(t.size)} sur la seedbox, ${fmtBytes(t.match.size_bytes)} sur TR4KER) : ` +
          `le client devra retélécharger les morceaux manquants. Continuer ?`)) return
        rowBusy[t.config + t.hash] = true
        try {
          const r = await crossRaw(t)
          api.ui.toast('Cross-seed lancé', `Ajouté dans ${r.savepath} — le client vérifie les fichiers puis seed`)
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        rowBusy[t.config + t.hash] = false
      }
      // ---- upload assisté ----
      const up = ref(null) // { item, loading, err, prep, form, busy, done, result }

      const parentCats = computed(() => (up.value?.prep?.categories || []).filter((c) => !c.parent_id))
      const subCats = computed(() => {
        const cats = up.value?.prep?.categories || []
        const parent = cats.find((c) => c.slug === up.value?.form?.category_slug && !c.parent_id)
        return parent ? cats.filter((c) => c.parent_id === parent.id) : []
      })
      const tagHint = computed(() => {
        const r = up.value?.prep?.release || {}
        return [r.resolution, r.lang, r.video].filter(Boolean).join(', ')
      })

      async function openUpload(item) {
        up.value = { item, loading: true, err: '', prep: null, form: null, busy: false, done: false, result: null }
        try {
          const prep = await api.fetch('/upload/prepare', { method: 'POST', body: { hash: item.hash, config: item.config } })
          const rel = prep.release || {}
          up.value.prep = prep
          up.value.form = reactive({
            name: prep.name,
            category_slug: prep.category_guess || '',
            subcategory_slug: '',
            year: rel.year || '',
            tmdb_id: prep.tmdb[0]?.id || 0,
            tmdb_type: prep.tmdb_type,
            poster_url: prep.tmdb[0]?.poster_url || '',
            tags: [rel.resolution, rel.lang].filter(Boolean).join(', '),
            presentation: prep.presentation,
            nfo: '',
            description: '',
            is_anonymous: false,
            seed_after: true,
          })
        } catch (e) {
          up.value.err = e?.data?.statusMessage || e?.message || 'Erreur inconnue'
        }
        up.value.loading = false
      }
      function pickTmdb(r) {
        up.value.form.tmdb_id = r?.id || 0
        up.value.form.poster_url = r?.poster_url || ''
        if (r?.year && !up.value.form.year) up.value.form.year = String(r.year)
      }
      async function submitUpload() {
        const u = up.value
        u.busy = true
        try {
          u.result = await api.fetch('/upload/commit', { method: 'POST', body: { info_hash: u.prep.info_hash, form: { ...u.form } } })
          u.done = true
          u.item.status = 'uploaded'
          api.ui.toast('Upload envoyé', `« ${u.form.name} » est en attente de validation${u.result.seeded ? ' et remis en seed' : ''}`)
          loadMap()
        } catch (e) {
          api.ui.toast('Upload : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        u.busy = false
      }
      // le fichier existe déjà sur TR4KER (preflight) → cross-seed de la version existante
      async function crossExisting() {
        const u = up.value
        u.busy = true
        try {
          const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: u.prep.existing.slug, target_hash: u.item.hash, config: u.item.config } })
          u.item.status = 'done'
          api.ui.toast('Cross-seed lancé', `Ajouté dans ${r.savepath} — le client vérifie puis seed`)
          up.value = null
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
          u.busy = false
        }
      }
      const goFiche = (slug) => { window.location.href = '/torrent/' + slug }
      const trackerHost = (u) => {
        try { return new URL(u).hostname.replace(/^(www|connect|tracker|announce)\./, '') } catch { return u ? '?' : '—' }
      }

      const fails = (b) => (b.errors ? ' (' + b.errors + ' échec' + (b.errors > 1 ? 's' : '') + ')' : '')
      async function crossAll() {
        const todo = (scan.value?.items || []).filter((t) => t.status === 'cross') // taille exacte uniquement
        if (!todo.length) return
        if (!confirm(`Cross-seeder ${todo.length} torrent(s) ? Chaque ajout télécharge un .torrent sur TR4KER (envois espacés automatiquement).`)) return
        bulk.value = { done: 0, total: todo.length, errors: 0 }
        for (const t of todo) {
          try {
            await crossRaw(t)
            bulk.value.done++
          } catch (e) {
            bulk.value.errors++
            if ((e?.status || e?.statusCode) === 429) { // tracker throttlé : inutile d'insister
              api.ui.toast('Cross-seed interrompu', 'Le tracker throttle (429) — relance « Tout cross-seeder » dans une minute ou deux')
              break
            }
          }
        }
        const b = bulk.value
        api.ui.toast('Cross-seed en masse', `${b.done}/${b.total} lancé(s)${fails(b)}`)
        bulk.value = null
        loadMap()
      }
      async function refresh() {
        loading.value = true
        try {
          const r = await api.fetch('/torrents', { query: selected.value ? { config: selected.value } : {} })
          // transfer = null quand le client n'expose pas les débits globaux (ex. Hydra)
          status.value = { ok: true, dl: r.transfer?.dl ?? null, up: r.transfer?.up ?? null }
          torrents.value = r.torrents
          if (!selected.value) selected.value = r.config.id
        } catch (e) {
          const msg = e?.data?.statusMessage || e?.message || 'Erreur'
          if (e?.status === 400 || e?.statusCode === 400) configured.value = false
          status.value = { ok: false, error: msg }
        }
        loading.value = false
      }
      function select(id) {
        if (selected.value === id) return
        selected.value = id
        status.value = null
        torrents.value = []
        refresh()
      }
      onMounted(async () => {
        try {
          const c = await api.fetch('/configs')
          configs.value = c.configs
          selected.value = c.defaultConfig
        } catch {}
        refresh()
        timer = setInterval(() => { if (tab.value === 'suivi') refresh() }, 5000)
      })
      onUnmounted(() => clearInterval(timer))
      const fmtAgo = (ts) => {
        const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
        return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`
      }
      const fmtSpeed = (b) => !b ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo/s' : Math.round(b / 1024) + ' Ko/s'
      const fmtBytes = (b) => !b ? '—' : b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' Go' : (b / 1048576).toFixed(0) + ' Mo'
      const stateLabel = (s) => ({
        downloading: 'Téléchargement', stalledDL: 'En attente ↓', metaDL: 'Métadonnées',
        uploading: 'Seed', stalledUP: 'Seed (calme)', queuedDL: 'File ↓', queuedUP: 'File ↑',
        pausedDL: 'Pause ↓', pausedUP: 'Pause ↑', stoppedDL: 'Arrêté ↓', stoppedUP: 'Arrêté ↑',
        checkingDL: 'Vérification', checkingUP: 'Vérification', error: 'Erreur', missingFiles: 'Fichiers manquants',
      })[s] || s
      const stateClass = (s) => /error|missing/i.test(s) ? 'b-bad' : /up|seed/i.test(s) ? 'b-cat' : ''
      return {
        torrents, status, loading, configured, configs, selected, select, refresh, fmtSpeed, fmtBytes, stateLabel, stateClass,
        tab, scan, scanning, scanErr, filter, rowBusy, bulk, countsC, crossable, multiCfg, FILTERS, visible,
        doScan, openCross, crossOne, crossAll, fails, fmtAgo,
        up, parentCats, subCats, tagHint, openUpload, pickTmdb, submitUpload, crossExisting, goFiche, trackerHost,
      }
    },
  }
  api.ui.registerPage({ path: '/p/seedbox-qbit', component: Page, title: 'Seedbox', icon: 'HardDriveDownload', order: 40 })
}
