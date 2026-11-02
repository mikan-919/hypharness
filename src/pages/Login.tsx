import { router } from '@inertiajs/react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { post } from '@/lib/api'

type Options<T> = { challengeId: string; options: T }

export default function Login() {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const run = (task: () => Promise<void>) => async () => {
    setError('')
    try {
      await task()
      router.visit('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const register = run(async () => {
    const { challengeId, options } = await post<
      Options<Parameters<typeof startRegistration>[0]['optionsJSON']>
    >('/auth/register/options', { name })
    const response = await startRegistration({ optionsJSON: options })
    await post('/auth/register', { challengeId, response })
  })

  const login = run(async () => {
    const { challengeId, options } = await post<
      Options<Parameters<typeof startAuthentication>[0]['optionsJSON']>
    >('/auth/login/options')
    const response = await startAuthentication({ optionsJSON: options })
    await post('/auth/login', { challengeId, response })
  })

  return (
    <main className='mx-auto flex max-w-sm flex-col gap-6 p-8'>
      <h1 className='text-2xl font-bold'>hypharness</h1>
      <Button onClick={login}>passkey でログイン</Button>
      <form
        className='flex flex-col gap-2'
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          register()
        }}
      >
        <Input
          placeholder='名前'
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Button type='submit' variant='outline'>
          passkey で登録
        </Button>
      </form>
      {error && <p className='text-destructive text-sm'>{error}</p>}
    </main>
  )
}
