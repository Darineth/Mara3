<!-- Roster sidebar: alphabetized user list with away/self markers; emits a
     selection so the host can DM or insert a mention. -->
<script lang="ts">
  import type { UserInfo } from '@mara/client-core';
  import { monogramInitial } from '@mara/chat-render';

  let {
    users = [],
    selfToken = null,
    showAvatars = true,
    onselect,
  }: {
    users: UserInfo[];
    selfToken?: number | null;
    /** Show each user's avatar (image or monogram) before the name. */
    showAvatars?: boolean;
    onselect?: (user: UserInfo) => void;
  } = $props();

  // Sort a copy so the incoming prop array is never mutated in place.
  const sorted = $derived([...users].sort((a, b) => a.name.localeCompare(b.name)));
</script>

<div class="mara-userlist">
  <div class="mara-userlist-head">Users · {users.length}</div>
  <ul>
    <!-- `away` is the away message string; "" means present (no marker), any
         non-empty value dims the entry and adds the 💤 + tooltip. -->
    {#each sorted as user (user.token)}
      <li>
        <button
          type="button"
          style="color:{user.color}"
          class:away={user.away !== ''}
          onclick={() => onselect?.(user)}
          title={user.away ? `Away: ${user.away}` : user.name}
        >
          <!-- Avatar: hosted image, or a colored-initial monogram fallback. The wire
               validates the path, so a truthy value is a safe /avatars/ or /uploads/ URL. -->
          {#if showAvatars}
            {#if user.avatar}
              <img class="mara-ul-avatar" src={user.avatar} alt="" loading="lazy" />
            {:else}
              <span class="mara-ul-avatar mono" style="background:{user.color}" aria-hidden="true"
                >{monogramInitial(user.name)}</span
              >
            {/if}
          {/if}
          <span class="name"
            >{user.name}{#if user.token === selfToken}<span class="you">
                (you)</span
              >{/if}{#if user.away}<span class="zzz"> 💤</span>{/if}</span
          >
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .mara-userlist {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    border-left: 1px solid var(--mara-border, #333);
  }
  .mara-userlist-head {
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
    border-bottom: 1px solid var(--mara-border, #333);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    overflow-y: auto;
  }
  button {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.3rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
    font: inherit;
  }
  button:hover {
    background: var(--mara-hover, #2f2f2f);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mara-ul-avatar {
    flex: none;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    object-fit: cover;
    background: var(--mara-border, #333);
  }
  .mara-ul-avatar.mono {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    font-size: 0.72rem;
    overflow: hidden;
  }
  .away {
    opacity: 0.55;
  }
  .you {
    opacity: 0.5;
    font-size: 0.85em;
  }
</style>
