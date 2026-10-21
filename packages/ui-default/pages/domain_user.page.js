import $ from 'jquery';
import _ from 'lodash';
import { ActionDialog, confirm, InfoDialog, prompt } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import {
  delay, i18n, request, tpl,
} from 'vj/utils';

const INIT_PASSWORD = '123456';

function parseUsernames(raw) {
  return [...new Set(String(raw || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean))];
}

const page = new NamedPage('domain_user', () => {
  function filterDomainUsers() {
    const q = String($('[name="user_search"]').val() || '').trim().toLowerCase();
    $('.domain-users tbody tr[data-uid]').each((_, el) => {
      const $row = $(el);
      const uid = String($row.attr('data-uid') || '');
      const note = $row.find('[data-note-value]').text();
      const name = `${$row.find('.col--user').text()} ${note}`.toLowerCase();
      const hit = !q || uid.includes(q) || name.includes(q);
      $row.toggle(hit);
    });
  }

  function setInlineStudentNote(row, note) {
    const cell = row.querySelector('.col--user');
    if (!cell) return;
    let inline = cell.querySelector('[data-student-note-inline]');
    if (!note) {
      inline?.remove();
      return;
    }
    if (!inline) {
      inline = document.createElement('span');
      inline.className = 'domain-student-note__inline';
      inline.dataset.studentNoteInline = '';
    }
    inline.textContent = `（${note}）`;
    const notJoined = cell.querySelector('.text-orange');
    cell.insertBefore(inline, notJoined || null);
  }

  async function handleStudentNoteAction(ev) {
    const button = ev.currentTarget;
    const cell = button.closest('[data-student-note-cell]');
    const row = button.closest('tr[data-uid]');
    if (!cell || !row) return;
    const view = cell.querySelector('.domain-student-note__view');
    const editor = cell.querySelector('.domain-student-note__editor');
    const input = cell.querySelector('[data-note-input]');
    const action = button.dataset.noteAction;
    if (action === 'edit') {
      input.value = row.dataset.studentNote || '';
      view.hidden = true;
      editor.hidden = false;
      input.focus();
      return;
    }
    if (action === 'cancel') {
      input.value = row.dataset.studentNote || '';
      editor.hidden = true;
      view.hidden = false;
      return;
    }
    if (action !== 'save') return;
    button.disabled = true;
    try {
      const result = await request.post(UiContext.studentNoteUrl, {
        uid: Number(row.dataset.uid),
        note: input.value,
      });
      const note = String(result?.note || '');
      row.dataset.studentNote = note;
      input.value = note;
      cell.querySelector('[data-note-value]').textContent = note || '—';
      setInlineStudentNote(row, note);
      editor.hidden = true;
      view.hidden = false;
      filterDomainUsers();
    } catch (error) {
      Notification.error(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function exitRoleEdit($row, revert = false) {
    const $cell = $row.find('.col--role');
    const $select = $cell.find('select[name="role"]');
    if (revert && $select.length) {
      $select.val($row.attr('data-role') || '');
    }
    $cell.find('.domain-user-role__text').show();
    $cell.find('.domain-user-role__edit').hide();
    $row.find('.domain-user-role__btn-edit').css('display', 'inline-flex');
    $row.find('.domain-user-role__btn-cancel').css('display', 'none');
    $row.removeClass('domain-user-row--editing-role');
  }

  function enterRoleEdit($row) {
    $('.domain-user-row--editing-role').each((_, el) => {
      exitRoleEdit($(el), true);
    });
    const $cell = $row.find('.col--role');
    $cell.find('.domain-user-role__text').hide();
    $cell.find('.domain-user-role__edit').show();
    $row.find('.domain-user-role__btn-edit').hide();
    $row.find('.domain-user-role__btn-cancel').css('display', 'inline-flex');
    $row.addClass('domain-user-row--editing-role');
    $cell.find('select[name="role"]').trigger('focus');
  }

  async function postDomainUser(data) {
    const res = await request.post('', data);
    if (res?.url) {
      const destPath = new URL(res.url, window.location.origin).pathname;
      if (destPath.includes('/user/sudo') || destPath.includes('/user/login')) {
        window.location.href = res.url;
        return null;
      }
    }
    return res;
  }

  const addUserDialogContent = $(tpl`
    <div>
      <div class="row"><div class="columns">
        <h1>${i18n('Add User')}</h1>
      </div></div>
      <div class="row"><div class="columns">
        <label>
          ${i18n('Login username')}
          <input name="add_domain_user_unames" type="text" class="textbox" autocomplete="off" data-autofocus
            placeholder="${i18n('One or more usernames, separated by commas')}">
        </label>
        <p class="text-muted" style="margin-top:8px;font-size:13px;">
          ${i18n('New accounts use initial password {0}. Existing usernames are added to this domain with the selected role.', INIT_PASSWORD)}
        </p>
      </div></div>
      <div class="row"><div class="columns">
        <label>
          Role
          <select name="add_domain_user_role" class="select"></select>
        </label>
      </div></div>
    </div>
  `);
  addUserDialogContent.appendTo(document.body);
  const addUserNameInput = addUserDialogContent.find('[name="add_domain_user_unames"]');
  const addUserRoleSelect = addUserDialogContent.find('[name="add_domain_user_role"]');
  UiContext.roles
    .filter((r) => !['default', 'guest'].includes(r))
    .forEach((r) => addUserRoleSelect.append($('<option>').attr('value', r).text(r)));
  const addUserDialog = new ActionDialog({
    $body: addUserDialogContent,
    onDispatch(action) {
      if (action === 'ok') {
        const names = parseUsernames(addUserNameInput.val());
        if (!names.length) {
          addUserNameInput.trigger('focus');
          Notification.error(i18n('Please enter at least one username.'));
          return false;
        }
        if (!addUserRoleSelect.val()) {
          addUserRoleSelect.trigger('focus');
          return false;
        }
      }
      return true;
    },
  });
  addUserDialog.clear = function clear() {
    addUserNameInput.val('');
    return this;
  };

  $('[name="user_search"]').on('input', () => filterDomainUsers());

  $('.domain-users__sort-role').on('click keydown', (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.type === 'keydown') ev.preventDefault();
    const params = new URLSearchParams(window.location.search);
    const next = params.get('sortRole') === 'asc' ? 'desc' : 'asc';
    params.set('sortRole', next);
    params.set('page', '1');
    window.location.search = params.toString();
  });

  $('.not-joined').data('tooltip', i18n('Click to view detailed instructions.'));
  $('.not-joined').addClass('text-orange');
  $(document).on('click', '.not-joined', () => {
    new InfoDialog({
      $body: tpl`
        <div class="typo">
          <p>${i18n('Users will have to manually join the domain first before selected roles can be applied.')}</p>
          <p>${i18n('To join the domain, users can click the "Join Domain" button on "My Domain" page.')}</p>
          <p>${i18n('Or use the following link:')}</p>
          <p><a href="/domain/join?target=${UiContext.domainId}">/domain/join?target=${UiContext.domainId}</a></p>
        </div>`,
    }).open();
  });

  async function handleClickAddUser() {
    const action = await addUserDialog.clear().open();
    if (action !== 'ok') return;
    const usernames = parseUsernames(addUserNameInput.val());
    const role = String(addUserRoleSelect.val() || '');
    const join = UiContext.domainId === 'system' || UiContext.canForceJoin;
    try {
      const posted = await postDomainUser({
        operation: 'create_users',
        usernames,
        role,
        join,
      });
      if (!posted?.ok) return;
      const { created = [], linked = [] } = posted;
      if (created.length && linked.length) {
        Notification.success(i18n('Created {0} user(s), linked {1} existing.', created.length, linked.length));
      } else if (created.length) {
        Notification.success(i18n('Created {0} user(s), initial password {1}.', created.length, INIT_PASSWORD));
      } else {
        Notification.success(i18n('Added {0} user(s) to this domain.', linked.length || usernames.length));
      }
      const reloadUrl = new URL(window.location.href);
      reloadUrl.searchParams.set('page', '1');
      reloadUrl.searchParams.delete('noTemplate');
      reloadUrl.searchParams.delete('pjax');
      if (posted.uids?.length === 1) reloadUrl.searchParams.set('find', String(posted.uids[0]));
      else reloadUrl.searchParams.delete('find');
      await delay(400);
      window.location.replace(reloadUrl.pathname + reloadUrl.search);
    } catch (error) {
      Notification.error(error.message);
    }
  }

  function ensureAndGetSelectedUsers() {
    const users = _.map(
      $('.domain-users tbody [type="checkbox"]:checked'),
      (ch) => $(ch).attr('data-uid') || $(ch).closest('tr').attr('data-uid'),
    );
    if (users.length === 0) {
      Notification.error(i18n('Please select at least one user to perform this operation.'));
      return null;
    }
    return users;
  }

  async function handleClickRemoveSelected() {
    const selectedUsers = ensureAndGetSelectedUsers();
    if (selectedUsers === null) return;
    if (!(await confirm(`${i18n('Confirm deleting the selected user accounts?')}
${i18n('Accounts will be permanently deleted and cannot be restored.')}`))) return;
    try {
      const posted = await postDomainUser({
        operation: 'kick',
        uids: selectedUsers,
      });
      if (posted === null) return;
      Notification.success(i18n('Selected user accounts have been deleted.'));
      await delay(2000);
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  }

  async function handleClickSetSelected() {
    const res = await prompt('Set Role', {
      role: {
        type: 'text',
        required: true,
        label: 'Set Roles for selected users',
        options: UiContext.roles.filter((i) => !['guest'].includes(i)),
      },
    });
    if (!res?.role) return;
    const selectedUsers = ensureAndGetSelectedUsers();
    if (selectedUsers === null) return;
    try {
      const posted = await postDomainUser({
        operation: 'set_users',
        uids: selectedUsers,
        role: res.role,
      });
      if (posted === null) return;
      Notification.success(i18n('Role has been updated to {0} for selected users.', res.role));
      await delay(2000);
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  }

  async function handleClickInitPassword(ev) {
    const $row = $(ev.currentTarget).closest('tr');
    const uid = $row.attr('data-uid');
    const uname = $row.find('.col--user .user-profile__uname, .col--user a').first().text().trim()
      || $row.find('.col--user').text().trim();
    if (!uid) return;
    if (!(await confirm(i18n('Confirm initializing password to {0} for user {1}?', INIT_PASSWORD, uname || uid)))) return;
    try {
      const posted = await postDomainUser({
        operation: 'init_password',
        uids: [uid],
      });
      if (posted === null) return;
      Notification.success(i18n('Password has been reset to {0}.', INIT_PASSWORD));
    } catch (error) {
      Notification.error(error.message);
    }
  }

  async function handleChangeUserRole(ev) {
    const $select = $(ev.currentTarget);
    const $row = $select.closest('tr');
    const role = String($select.val());
    try {
      const posted = await postDomainUser({
        operation: 'set_users',
        uids: [$row.attr('data-uid')],
        role,
      });
      if (posted === null) return;
      $row.attr('data-role', role);
      $row.find('.domain-user-role__text').text(role);
      Notification.success(i18n('Role has been updated to {0}.', role));
      exitRoleEdit($row, false);
    } catch (error) {
      Notification.error(error.message);
      exitRoleEdit($row, true);
    }
  }

  $('[name="add_user"]').click(() => handleClickAddUser());
  $('[name="remove_selected"]').click(() => handleClickRemoveSelected());
  $('[name="set_roles"]').click(() => handleClickSetSelected());
  $('.domain-users').on('click', '.domain-user-role__btn-edit', (ev) => {
    enterRoleEdit($(ev.currentTarget).closest('tr'));
  });
  $('.domain-users').on('click', '.domain-user-role__btn-cancel', (ev) => {
    exitRoleEdit($(ev.currentTarget).closest('tr'), true);
  });
  $('.domain-users').on('click', '[data-note-action]', (ev) => handleStudentNoteAction(ev));
  $('.domain-users').on('keydown', '[data-note-input]', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $(ev.currentTarget).closest('[data-student-note-cell]').find('[data-note-action="save"]').trigger('click');
    } else if (ev.key === 'Escape') {
      $(ev.currentTarget).closest('[data-student-note-cell]').find('[data-note-action="cancel"]').trigger('click');
    }
  });
  $('.domain-users').on('change', 'select[name="role"]', (ev) => handleChangeUserRole(ev));
  $('.domain-users').on('click', '.domain-user-init-pwd', (ev) => handleClickInitPassword(ev));
});

export default page;
