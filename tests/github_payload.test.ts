import { githubEventRef, normalizeGithubPayload } from '../supabase/functions/_shared/github.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('GitHub payload normalization removes oversized/unneeded data', () => {
  const payload = {
    action:'opened',
    repository:{id:1,full_name:'owner/repo',private:true,default_branch:'main',html_url:'https://github.com/owner/repo',huge:'x'.repeat(10000)},
    sender:{id:2,login:'octocat',extra:'x'.repeat(10000)},
    issue:{number:7,title:'Bug',state:'open',html_url:'https://github.com/owner/repo/issues/7',user:{login:'octocat'}},
    comment:{id:3,html_url:'https://github.com/owner/repo/issues/7#issuecomment-3',user:{login:'octocat'},body:'y'.repeat(10000)},
    unexpected:{blob:'z'.repeat(20000)},
  }
  const normalized: any = normalizeGithubPayload(payload, 'issue_comment')
  assert(!('unexpected' in normalized), 'Unexpected raw payload field leaked into normalized payload')
  assert(!('huge' in normalized.repository), 'Repository raw field leaked')
  assert(normalized.comment.body.length <= 4001, 'Comment body was not clipped')
})

Deno.test('Issue comments map back to issue refs', () => {
  const ref: any = githubEventRef({ repository:{full_name:'owner/repo'}, issue:{number:42,html_url:'https://github.com/owner/repo/issues/42'} }, 'issue_comment')
  assert(ref?.ref_type === 'issue', 'Issue comment did not map to issue ref')
  assert(ref?.ref_number === '42', 'Issue number was not preserved')
})

Deno.test('Pull request reviews map back to pull request refs', () => {
  const ref: any = githubEventRef({ repository:{full_name:'owner/repo'}, pull_request:{number:9,head:{sha:'abc'},html_url:'https://github.com/owner/repo/pull/9'} }, 'pull_request_review')
  assert(ref?.ref_type === 'pull_request', 'Review did not map to pull request')
  assert(ref?.sha === 'abc', 'PR head SHA was not preserved')
})
