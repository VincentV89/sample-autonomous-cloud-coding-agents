import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import '@cloudscape-design/global-styles/index.css';

const stages = {
  'intent-capture': 'Intent capture',
  requirements: 'Requirements',
  acceptance: 'Acceptance criteria',
};

function download(markdown, name) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function Question({ question, canAnswer, busy, mutate, owner, assignments }) {
  const [value, setValue] = useState(question.answer?.value ?? '');
  useEffect(() => setValue(question.answer?.value ?? ''), [question.answer?.value]);
  function answer(value, deferred) {
    return mutate({ action: 'answer', question: question.id, value, deferred });
  }
  return <Container header={<Header variant="h3">{question.prompt}</Header>}>
    <SpaceBetween size="s">
      {owner && <FormField label="Assigned to">
        <Select
          options={assignments}
          selectedOption={assignments.find(option => option.value === (question.assignee ?? ''))}
          disabled={busy}
          onChange={({ detail }) => mutate({ action: 'assign', question: question.id, user: detail.selectedOption.value })}
        />
      </FormField>}
      {canAnswer && question.options.length > 0 && <SpaceBetween direction="horizontal" size="xs">
        {question.options.map(option => <Button key={option} disabled={busy} onClick={() => answer(option, false)}>{option}</Button>)}
      </SpaceBetween>}
      <FormField label="Answer" description={canAnswer ? 'Saves when you leave the field.' : undefined}>
        <Textarea value={value} disabled={!canAnswer || busy}
          onChange={({ detail }) => setValue(detail.value)}
          onBlur={() => {
            if (value.trim() && value.trim() !== question.answer?.value) void answer(value, false);
          }}
        />
      </FormField>
      {question.answer && <StatusIndicator type={question.answer.deferred ? 'pending' : 'success'}>
        {question.answer.deferred ? 'Deferred' : 'Saved'}
      </StatusIndicator>}
      {canAnswer && <Button disabled={busy} onClick={() => answer(value, true)}>Decide later</Button>}
    </SpaceBetween>
  </Container>;
}

function Workspace({ api, id, user }) {
  const [workspace, setWorkspace] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(false);
  const [invitee, setInvitee] = useState('');
  const [inviteRole, setInviteRole] = useState('contributor');
  const [comment, setComment] = useState('');
  const locked = useRef(false);
  const endpoint = `/intents/${encodeURIComponent(id ?? '')}`;
  async function reload() {
    setError('');
    try { setWorkspace((await api(endpoint)).data); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { if (id) void reload(); }, [id]);
  async function mutate(action) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    setStatus('Saving…');
    try {
      const result = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ revision: workspace.revision, ...action }),
      });
      setWorkspace(result.data);
      setStatus('Saved');
      return true;
    } catch (failure) {
      setError(failure.message);
      setStatus('');
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function copy(value) {
    try { await navigator.clipboard.writeText(value); setStatus('Copied'); }
    catch (failure) { setError(failure.message); }
  }
  if (!id) return <Container header={<Header>Intents</Header>}>
    <SpaceBetween size="m">
      <p>Start in Slack with <code>/plan owner/repo followed by your idea</code>. Open the workspace link from Shoof.</p>
      <Button onClick={() => copy(user)}>Copy my member ID</Button>
      {status && <StatusIndicator type="success">{status}</StatusIndicator>}
      {error && <Alert type="error">{error}</Alert>}
    </SpaceBetween>
  </Container>;
  if (!workspace) return error ? <Alert type="error" action={<Button onClick={reload}>Retry</Button>}>{error}</Alert> : <Spinner />;
  const owner = workspace.role === 'owner';
  const questions = workspace.questions[workspace.stage] ?? [];
  const canAnswer = !workspace.pendingAction && ['owner', 'contributor'].includes(workspace.role);
  const published = workspace.versions.at(-1);
  const publishedCurrent = published && published.commit === workspace.headCommit;
  const assignments = [
    { label: 'Unassigned', value: '' },
    { label: 'Owner', value: workspace.owner },
    ...Object.entries(workspace.members).filter(([, role]) => role === 'contributor').map(([value]) => ({ label: value, value })),
  ];
  const links = (row) => `https://github.com/${workspace.repo}/blob/${row.commit}/${row.path}`;
  return <SpaceBetween size="l">
    <Header description={workspace.repo} actions={<SpaceBetween direction="horizontal" size="xs">
      <Button disabled={busy} onClick={reload}>Refresh</Button>
      {owner && <Button disabled={busy || Boolean(workspace.pendingAction)} onClick={() => setInvite(true)}>Invite people</Button>}
    </SpaceBetween>}>{workspace.idea}</Header>
    {error && <Alert type="error">{error}</Alert>}
    {status && <StatusIndicator type={busy ? 'loading' : 'success'}>{status}</StatusIndicator>}
    {workspace.pendingAction && <Alert type="warning" action={owner && <Button disabled={busy} onClick={() => mutate(workspace.pendingAction)}>Resume</Button>}>
      A repository update is awaiting completion.
    </Alert>}
    <Tabs tabs={[
      { id: 'questions', label: 'Questions', content: <SpaceBetween size="m">
        <Header variant="h2">{stages[workspace.stage] ?? 'All stages approved'}</Header>
        {workspace.stage && !questions.length && <Alert action={owner && <Button loading={busy} onClick={() => mutate({ action: 'questions' })}>Generate questions</Button>}>
          {owner ? 'Generate questions for this stage.' : 'The owner has not opened this stage yet.'}
        </Alert>}
        {questions.map(question => <Question key={question.id} question={question} owner={owner} assignments={assignments}
          busy={busy || Boolean(workspace.pendingAction)} mutate={mutate}
          canAnswer={canAnswer && (owner || !question.assignee || question.assignee === workspace.currentUser)}
        />)}
        {owner && questions.length > 0 && <Button variant="primary"
          disabled={busy || Boolean(workspace.pendingAction) || questions.some(question => !question.answer)}
          onClick={() => mutate({ action: 'checkpoint' })}>Approve and commit stage</Button>}
        <Container header={<Header variant="h3">Discussion</Header>}><SpaceBetween size="s">
          {(workspace.comments ?? []).map((entry, index) => <p key={index}><strong>{entry.user}</strong> {entry.value}</p>)}
          <FormField label="Comment"><Textarea value={comment} onChange={({ detail }) => setComment(detail.value)} /></FormField>
          <Button disabled={busy || Boolean(workspace.pendingAction) || !comment.trim()} onClick={async () => {
            if (await mutate({ action: 'comment', value: comment })) setComment('');
          }}>Add comment</Button>
        </SpaceBetween></Container>
      </SpaceBetween> },
      { id: 'review', label: 'Review spec', content: <SpaceBetween size="m">
        {workspace.checkpoints.map(row => <Container key={row.stage} header={<Header variant="h3">{stages[row.stage]}</Header>}>
          <pre className="intent-markdown">{row.markdown}</pre>
          <Link href={links(row)} external>View checkpoint</Link>
        </Container>)}
        {workspace.stage && <Alert>Approve the remaining stages before publishing.</Alert>}
        {workspace.draftMarkdown && <Container header={<Header variant="h3">Consolidated intent</Header>}>
          <pre className="intent-markdown">{workspace.draftMarkdown}</pre>
        </Container>}
        {owner && !workspace.stage && !publishedCurrent && <Button variant="primary" loading={busy}
          disabled={Boolean(workspace.pendingAction)} onClick={() => mutate({ action: 'publish' })}>Publish intent</Button>}
        {owner && !workspace.stage && publishedCurrent && <Button disabled={busy} onClick={() => mutate({ action: 'revise' })}>Start next revision</Button>}
      </SpaceBetween> },
      { id: 'versions', label: 'Published versions', content: <Table
        items={[...workspace.versions].reverse()}
        empty={<p>Publish the approved intent to create the first version.</p>}
        columnDefinitions={[
          { id: 'version', header: 'Version', cell: row => `v${row.version}` },
          { id: 'commit', header: 'GitHub', cell: row => <Link href={links(row)} external>{row.commit.slice(0, 8)}</Link> },
          { id: 'download', header: 'Spec', cell: row => <Button onClick={() => download(row.markdown, `intent-v${row.version}.md`)}>Download Markdown</Button> },
          { id: 'build', header: 'Develop', cell: row => workspace.role !== 'reviewer' && <Button onClick={() => copy(
            `@Shoof develop --intent=${workspace.id}@v${row.version} Build and verify the approved intent.`,
          )}>Copy develop command</Button> },
        ]}
      /> },
    ]} />
    {invite && <Modal visible header="Invite people" onDismiss={() => setInvite(false)}
      footer={<Button variant="primary" loading={busy} disabled={!invitee.trim()} onClick={async () => {
        if (await mutate({ action: 'member', user: invitee.trim(), role: inviteRole })) {
          setInvitee(''); setInvite(false);
        }
      }}>Add member</Button>}>
      <SpaceBetween size="m">
        <FormField label="Platform member ID" description="Ask your teammate to copy their member ID from the Intents landing page.">
          <Input value={invitee} onChange={({ detail }) => setInvitee(detail.value)} />
        </FormField>
        <FormField label="Role">
          <Select selectedOption={{ label: inviteRole, value: inviteRole }}
            options={['contributor', 'reviewer'].map(value => ({ label: value, value }))}
            onChange={({ detail }) => setInviteRole(detail.selectedOption.value)} />
        </FormField>
        <Button onClick={() => copy(location.href)}>Copy workspace link</Button>
        {Object.entries(workspace.members).map(([member, role]) => <SpaceBetween key={member} direction="horizontal" size="xs">
          <span>{member} ({role})</span>
          <Button disabled={busy} onClick={() => mutate({ action: 'remove-member', user: member })}>Remove member</Button>
        </SpaceBetween>)}
      </SpaceBetween>
    </Modal>}
  </SpaceBetween>;
}

export function mountIntents(container, options) {
  const root = createRoot(container);
  root.render(<Workspace {...options} />);
  return () => root.unmount();
}
