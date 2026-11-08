use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program::{transfer, Transfer};

// Solana Playground replaces this with your real Program ID when you build.
declare_id!("11111111111111111111111111111111");

pub const MAX_MEMBERS: usize = 10;
pub const MIN_CONTRIBUTION: u64 = 1_000_000; // 0.001 SOL

pub const STATE_OPEN: u8 = 0; // accepting members
pub const STATE_ACTIVE: u8 = 1; // draw done, rounds running
pub const STATE_COMPLETED: u8 = 2; // everyone got their payout

#[program]
pub mod paluwagan {
    use super::*;

    /// Creator opens a new paluwagan. The creator is automatically member #1.
    pub fn create_group(
        ctx: Context<CreateGroup>,
        name: String,
        contribution: u64,
        max_members: u8,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= 32, PaluwaganError::InvalidName);
        require!(contribution >= MIN_CONTRIBUTION, PaluwaganError::ContributionTooSmall);
        require!(
            max_members >= 2 && max_members as usize <= MAX_MEMBERS,
            PaluwaganError::InvalidMemberCount
        );

        let group = &mut ctx.accounts.group;
        group.creator = ctx.accounts.creator.key();
        group.name = name;
        group.contribution = contribution;
        group.max_members = max_members;
        group.members = vec![ctx.accounts.creator.key()];
        group.payout_order = vec![];
        group.contributions = vec![0];
        group.current_round = 0;
        group.paid_mask = 0;
        group.state = STATE_OPEN;
        group.bump = ctx.bumps.group;
        Ok(())
    }

    /// Anyone can join while the group is open and not full.
    pub fn join_group(ctx: Context<JoinGroup>) -> Result<()> {
        let member = ctx.accounts.member.key();
        let group = &mut ctx.accounts.group;
        require!(group.state == STATE_OPEN, PaluwaganError::NotOpen);
        require!(!group.members.contains(&member), PaluwaganError::AlreadyMember);
        require!(
            group.members.len() < group.max_members as usize,
            PaluwaganError::GroupFull
        );
        group.members.push(member);
        group.contributions.push(0);
        Ok(())
    }

    /// Creator locks the group and runs the on-chain "bunutan" (payout order draw).
    pub fn start_and_draw(ctx: Context<StartAndDraw>) -> Result<()> {
        let group_key = ctx.accounts.group.key();
        let group = &mut ctx.accounts.group;
        require!(group.state == STATE_OPEN, PaluwaganError::NotOpen);
        require!(group.members.len() >= 2, PaluwaganError::NotEnoughMembers);

        let clock = Clock::get()?;
        let seed = hashv(&[
            group_key.as_ref(),
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
        ])
        .to_bytes();

        // Fisher-Yates shuffle using bytes from the hash
        let n = group.members.len();
        let mut order: Vec<u8> = (0..n as u8).collect();
        for i in (1..n).rev() {
            let j = (seed[i] as usize) % (i + 1);
            order.swap(i, j);
        }

        group.payout_order = order;
        group.max_members = n as u8;
        group.state = STATE_ACTIVE;
        Ok(())
    }

    /// A member puts in this round's contribution. The SOL goes into the group
    /// account itself, which only this program can move. No organizer holds it.
    pub fn contribute(ctx: Context<Contribute>) -> Result<()> {
        let member_key = ctx.accounts.member.key();
        let (idx, amount) = {
            let group = &ctx.accounts.group;
            require!(group.state == STATE_ACTIVE, PaluwaganError::NotActive);
            let idx = group
                .members
                .iter()
                .position(|m| *m == member_key)
                .ok_or(PaluwaganError::NotMember)?;
            require!(
                group.paid_mask & (1u16 << idx) == 0,
                PaluwaganError::AlreadyContributed
            );
            (idx, group.contribution)
        };

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.member.to_account_info(),
                    to: ctx.accounts.group.to_account_info(),
                },
            ),
            amount,
        )?;

        let group = &mut ctx.accounts.group;
        group.paid_mask |= 1u16 << idx;
        group.contributions[idx] = group.contributions[idx].saturating_add(1);
        Ok(())
    }

    /// Once everyone has paid, anyone can trigger the payout. The program sends
    /// the whole pot to this round's winner from the draw. Nobody can redirect it.
    pub fn payout(ctx: Context<Payout>) -> Result<()> {
        let pot = {
            let group = &mut ctx.accounts.group;
            require!(group.state == STATE_ACTIVE, PaluwaganError::NotActive);

            let n = group.members.len();
            let full_mask: u16 = ((1u32 << n) - 1) as u16;
            require!(group.paid_mask == full_mask, PaluwaganError::NotAllPaid);

            let winner_idx = group.payout_order[group.current_round as usize] as usize;
            require_keys_eq!(
                group.members[winner_idx],
                ctx.accounts.winner.key(),
                PaluwaganError::WrongWinner
            );

            let pot = group
                .contribution
                .checked_mul(n as u64)
                .ok_or(PaluwaganError::Overflow)?;

            group.paid_mask = 0;
            group.current_round += 1;
            if group.current_round as usize == n {
                group.state = STATE_COMPLETED;
            }
            pot
        };

        let group_info = ctx.accounts.group.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();

        let new_group_balance = group_info
            .lamports()
            .checked_sub(pot)
            .ok_or(PaluwaganError::Overflow)?;
        let new_winner_balance = winner_info
            .lamports()
            .checked_add(pot)
            .ok_or(PaluwaganError::Overflow)?;

        **group_info.try_borrow_mut_lamports()? = new_group_balance;
        **winner_info.try_borrow_mut_lamports()? = new_winner_balance;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct CreateGroup<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Group::INIT_SPACE,
        seeds = [b"group", creator.key().as_ref(), name.as_bytes()],
        bump
    )]
    pub group: Account<'info, Group>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGroup<'info> {
    #[account(mut)]
    pub group: Account<'info, Group>,
    pub member: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartAndDraw<'info> {
    #[account(mut, has_one = creator)]
    pub group: Account<'info, Group>,
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub group: Account<'info, Group>,
    #[account(mut)]
    pub member: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(mut)]
    pub group: Account<'info, Group>,
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    pub caller: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Group {
    pub creator: Pubkey,
    #[max_len(32)]
    pub name: String,
    pub contribution: u64,
    pub max_members: u8,
    #[max_len(10)]
    pub members: Vec<Pubkey>,
    #[max_len(10)]
    pub payout_order: Vec<u8>,
    #[max_len(10)]
    pub contributions: Vec<u8>,
    pub current_round: u8,
    pub paid_mask: u16,
    pub state: u8,
    pub bump: u8,
}

#[error_code]
pub enum PaluwaganError {
    #[msg("Group name must be 1 to 32 characters")]
    InvalidName,
    #[msg("Contribution must be at least 0.001 SOL")]
    ContributionTooSmall,
    #[msg("Members must be between 2 and 10")]
    InvalidMemberCount,
    #[msg("This group is no longer accepting members")]
    NotOpen,
    #[msg("You are already a member")]
    AlreadyMember,
    #[msg("This group is full")]
    GroupFull,
    #[msg("At least 2 members are needed to start")]
    NotEnoughMembers,
    #[msg("This group has not started or is already finished")]
    NotActive,
    #[msg("You are not a member of this group")]
    NotMember,
    #[msg("You already contributed this round")]
    AlreadyContributed,
    #[msg("Not everyone has contributed this round yet")]
    NotAllPaid,
    #[msg("That wallet is not this round's winner")]
    WrongWinner,
    #[msg("Math overflow")]
    Overflow,
}
